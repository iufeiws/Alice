import type { CurrentTimeProvider } from "../../../core/time/src/index.js";
import { createCurrentTimeProvider } from "../../../core/time/src/index.js";
import { todayMessagingAnchor } from "../../../core/time/src/index.js";
import { parseZonedIso } from "../../../core/time/src/index.js";
import type { OutputRouter } from "../../../core/output-router/src/index.js";
import type { AgentOutput, ToolCall, ToolDefinition, ToolPlugin, ToolResult } from "../../../packages/types/src/index.js";
import { createId } from "../../../packages/types/src/index.js";
import type {
  AliceStore,
  InsertOutboundMessageInput,
  StoredConversationMessage
} from "../../../packages/storage/src/sqlite-store.js";

const fs = await import("node:fs");
const fsp = await import("node:fs/promises");
const path = await import("node:path");
const childProcess = await import("node:child_process");
const moduleApi = await import("node:module");
const require = moduleApi.createRequire(import.meta.url);

export type MessagingToolTarget = {
  plugin: string;
  accountId?: string;
  channelId?: string;
  userId?: string;
  sessionId: string;
};

export type TTSConfig = {
  backend?: "genie-tts" | "moss-onnx";
  genieBaseURL?: string;
  genieBaseURLExplicit?: boolean;
  genieHost?: string;
  geniePort?: number;
  geniePythonCommand?: string;
  genieServiceScript?: string;
  genieDataDir?: string;
  genieModelDir?: string;
  genieCharacterName?: string;
  genieLanguage?: string;
  genieReferenceAudio?: string;
  genieReferenceText?: string;
  genieOutputDir?: string;
  genieTimeoutMs?: number;
  genieIdleShutdownMs?: number;
  genieFfmpegCommand?: string;
  mossBaseURL?: string;
  mossBaseURLExplicit?: boolean;
  mossHost?: string;
  mossPort?: number;
  mossPythonCommand?: string;
  mossServiceScript?: string;
  mossModelDir?: string;
  mossReferenceAudio?: string;
  mossOutputDir?: string;
  mossTimeoutMs?: number;
  mossIdleShutdownMs?: number;
  mossFfmpegCommand?: string;
  mossVoiceCloneMaxTextTokens?: number;
};

export type VoiceSynthesisInput = {
  text: string;
  time: CurrentTimeProvider;
};

export type VoiceSynthesisResult = {
  assetId: string;
  filePath: string;
};

export type VoiceSynthesizer = ((input: VoiceSynthesisInput) => Promise<VoiceSynthesisResult>) & {
  noteActivity?(): void;
  prepare?(): Promise<void>;
  shutdown?(): Promise<void>;
};

export type MessagingToolsDeps = {
  store: Pick<
    AliceStore,
    | "listMessagesForConversation"
    | "listMessages"
    | "searchMessages"
    | "markMessagesReadAndCoreProcessed"
    | "insertOutboundMessage"
    | "markOutboundMessageSent"
    | "markOutboundMessageFailed"
  >;
  outputRouter: Pick<OutputRouter, "send">;
  time?: CurrentTimeProvider;
  sleep?: (ms: number) => Promise<void>;
  tts?: TTSConfig;
  voiceSynthesizer?: VoiceSynthesizer;
  getUserName?: () => string;
  getDefaultTarget?(): MessagingToolTarget | undefined;
  getShellSwitchLogs?(): Array<{
    time: string;
    personalityName: string;
    relationshipName: string;
  }>;
  appendMessageLog?(input: {
    direction: "inbound" | "outbound";
    plugin: string;
    kind: string;
    target?: string;
    sessionId?: string;
    status?: string;
    summary: string;
    error?: string;
  }): unknown;
  appendLog?(level: "info" | "warn" | "error", message: string): void;
};

export type MessagingToolPlugin = ToolPlugin & {
  noteLLMRequestStarted(): void;
  noteLLMSessionCompleted(): void;
};

const messageDelayMsPerCharacter = 480;
const minMessageDelayMs = 500;
const maxMessageDelayMs = 8_000;
const maxSendRetryAttempts = 3;
const checkChatMessageLimit = 500;
const recentCheckChatMessageCount = 50;
type SendType = "message" | "markdown" | "image" | "voice";
type SendPartResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
  content: string;
  storedId?: number;
};

export function createMessagingTools(deps: MessagingToolsDeps): MessagingToolPlugin {
  const time = deps.time ?? createCurrentTimeProvider("UTC");
  const userName = () => deps.getUserName?.() || "user";
  const sleep = deps.sleep ?? delay;
  const voiceSynthesizer = deps.voiceSynthesizer ?? createConfiguredVoiceSynthesizer(deps.tts, { appendLog: deps.appendLog });
  const shouldPrepareVoiceSynthesizer = Boolean(deps.tts || deps.voiceSynthesizer);
  let lastMessageTimestampMs: number | undefined;
  let activeLLMSession = false;
  let checkChatCallsInLLMSession = 0;
  let retryQueue = Promise.resolve();

  return {
    id: "messaging",
    noteLLMRequestStarted() {
      if (!activeLLMSession) {
        activeLLMSession = true;
        checkChatCallsInLLMSession = 0;
      }
      lastMessageTimestampMs = time.now().epochMs;
      voiceSynthesizer.noteActivity?.();
      if (shouldPrepareVoiceSynthesizer) {
        voiceSynthesizer.prepare?.().catch((error) => {
          deps.appendLog?.("warn", `voice tts prepare failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    },
    noteLLMSessionCompleted() {
      activeLLMSession = false;
      checkChatCallsInLLMSession = 0;
    },
    listTools() {
      return [checkChatTool, sendChatTool, searchMessagesTool];
    },
    async execute(call) {
      if (call.toolName === "check_chat" || call.toolName === "check_feishu" || call.toolName === "check_wechat" || call.toolName === "view_messages") return viewMessages(call);
      if (call.toolName === "send_chat" || call.toolName === "send_feishu" || call.toolName === "send_wechat" || call.toolName === "send_message") return sendMessage(call);
      if (call.toolName === "search_messages") return searchMessages(call);
      return { callId: call.id, ok: false, error: `Unknown messaging tool: ${call.toolName}` };
    }
  };

  async function viewMessages(call: ToolCall): Promise<ToolResult> {
    const target = resolveTarget(call);
    if (!target) return toolError(call, "No current messaging session is available");
    return viewMessagesForScope(call.id, target, resolveViewScope(call.input.__scope), { readonly: call.input.__preview === true });
  }

  function viewMessagesForScope(
    callId: string,
    target: MessagingToolTarget,
    scope: "recent" | "today" | "new",
    options: { readonly?: boolean } = {}
  ): ToolResult {
    const all = deps.store.listMessages(checkChatMessageLimit);
    let messages: StoredConversationMessage[];
    let sinceDate: Date;
    if (scope === "recent") {
      messages = all.slice(-recentCheckChatMessageCount);
      sinceDate = messages.length > 0 ? parseMessageTime(messages[0].createdAt, time.timeZone) : new Date(0);
    } else if (scope === "new") {
      const firstUnread = all.find((message) => message.direction === "inbound" && message.senderRole === "user" && !message.isRead);
      sinceDate = firstUnread ? parseMessageTime(firstUnread.createdAt, time.timeZone) : new Date(0);
      messages = firstUnread ? all.filter((message) => message.id >= firstUnread.id) : [];
    } else {
      const after = todayMessagingAnchor(time.timeZone, time.now().date).getTime();
      sinceDate = new Date(after);
      messages = all.filter((message) => parseMessageTime(message.createdAt, time.timeZone).getTime() >= after);
    }

    const shellEvents = scope === "new" && messages.length === 0 ? [] : readShellSwitchContext(sinceDate);
    if (!options.readonly) markViewedUserMessages(messages);
    return {
      callId,
      ok: true,
      output: appendCurrentTime(
        messages.length > 0 || shellEvents.length > 0
          ? formatTimelineBlocks(messages, shellEvents, time.timeZone, userName())
          : "nothing new",
        time.timeZone,
        time.now().date
      )
    };
  }

  function resolveViewScope(scopeHint?: unknown): "recent" | "new" {
    if (scopeHint === "recent") return "recent";
    if (!activeLLMSession) return "recent";
    checkChatCallsInLLMSession += 1;
    return checkChatCallsInLLMSession === 1 ? "recent" : "new";
  }

  function markViewedUserMessages(messages: StoredConversationMessage[]): void {
    const ids = messages
      .filter((message) => message.direction === "inbound" && message.senderRole === "user")
      .map((message) => message.id);
    if (ids.length === 0) return;
    deps.store.markMessagesReadAndCoreProcessed(ids, time.now().iso, createId("check_read"));
  }

  async function searchMessages(call: ToolCall): Promise<ToolResult> {
    const target = resolveTarget(call);
    if (!target) return toolError(call, "No current messaging session is available");
    const content = stringValue(call.input.content).trim();
    if (!content) return toolError(call, "content is required");
    const direction = normalizeDirection(call.input.direction);
    const limit = clampInt(call.input.limit, 3, 1, 20);
    const contextCount = clampInt(call.input.contextCount, 10, 1, 50);
    const hits = deps.store.searchMessages({
      plugin: target.plugin,
      query: content,
      direction,
      limit
    });
    const conversation = deps.store.listMessages(1000).filter((message) => message.plugin === target.plugin);
    const currentDate = time.now().date;
    const blocks = hits.map((hit) => {
      const hitIndex = conversation.findIndex((message) => message.id === hit.id);
      const context = hitIndex === -1 ? [hit] : contextSlice(conversation, hitIndex, contextCount);
      return {
        hitMessageId: hit.id,
        hitTime: formatLocalDateTime(parseMessageTime(hit.createdAt, time.timeZone), time.timeZone),
        direction,
        messages: formatMessageBlocks(context, time.timeZone, userName(), currentDate)
      };
    });

    return {
      callId: call.id,
      ok: true,
      output: blocks.length > 0
        ? blocks.map((block, index) => [
          `#${index + 1} hit=${block.hitMessageId} time=${block.hitTime}`,
          block.messages
        ].join("\n")).join("\n\n")
        : "nothing found"
    };
  }

  async function sendMessage(call: ToolCall): Promise<ToolResult> {
    const target = resolveTarget(call);
    if (!target) return toolError(call, "No current messaging session is available");
    const type = normalizeSendType(call.input.type);
    if (!type) return toolError(call, "unsupported message type");
    const content = stringValue(call.input.content);
    if (!content.trim()) return toolError(call, "content is required");
    const parts = type === "message" || type === "voice"
      ? content.split(/\r?\n/).map((part) => part.trim()).filter(Boolean)
      : [content];
    if (parts.length === 0) return toolError(call, "content is required");

    const results = [];
    for (const part of parts) {
      if (type === "voice") {
        results.push(...await sendVoicePart(target, part));
      } else {
        results.push(await sendOutputPart(target, type, part, { retry: true }));
      }
    }

    const failed = results.find((result) => !result.ok);
    const view = viewSentMessageResults(call.id, target, results);
    return failed ? { ...view, ok: false, error: failed.error } : view;
  }

  function viewSentMessageResults(callId: string, target: MessagingToolTarget, results: SendPartResult[]): ToolResult {
    const ids = new Set(results.map((result) => result.storedId).filter((id): id is number => typeof id === "number"));
    const messages = ids.size > 0
      ? deps.store.listMessagesForConversation(target.sessionId, Math.max(ids.size + 10, 20))
        .filter((message) => ids.has(message.id))
        .sort((left, right) => left.id - right.id)
      : [];
    const fallback = results
      .filter((result) => !result.storedId)
      .map((result) => `Alice:${result.content}${result.ok ? "" : "[发送失败]"}`);
    const output = [
      messages.length > 0 ? formatTimelineBlocks(messages, [], time.timeZone, userName()) : "",
      ...fallback
    ].filter(Boolean).join("\n");
    return {
      callId,
      ok: true,
      output: appendCurrentTime(output || "nothing new", time.timeZone, time.now().date)
    };
  }

  async function waitForMessageSendSlot(content: string): Promise<void> {
    const delayMs = messageDelayForContent(content);
    const nowMs = time.now().epochMs;
    if (lastMessageTimestampMs !== undefined) {
      const elapsedMs = nowMs - lastMessageTimestampMs;
      if (elapsedMs < delayMs) {
      await sleep(delayMs - elapsedMs);
      }
    }
  }

  async function sendVoicePart(target: MessagingToolTarget, text: string): Promise<SendPartResult[]> {
    await waitForMessageSendSlot(text);
    let synthesized: VoiceSynthesisResult | undefined;
    try {
      deps.appendLog?.("info", `voice tts start: chars=${Array.from(text).length}`);
      synthesized = await voiceSynthesizer({ text, time });
      const audioResult = await sendOutputPart(target, "voice", synthesized.assetId, { transcript: text, retry: false, skipWait: true });
      if (target.plugin !== "feishu" || !audioResult.ok) return [audioResult];
      const transcriptResult = await sendOutputPart(target, "message", `[${text}]`, { retry: true, skipWait: true });
      return [audioResult, transcriptResult];
    } catch (error) {
      const reason = normalizeSendError(error);
      if (!synthesized) {
        deps.appendMessageLog?.({
          direction: "outbound",
          plugin: target.plugin,
          kind: "audio",
          target: target.channelId ?? target.userId,
          sessionId: target.sessionId,
          status: "tts_failed",
          summary: text,
          error: reason
        });
      }
      return [{ ok: false, error: reason, content: text }];
    } finally {
      if (synthesized) await removeGeneratedVoice(synthesized.filePath);
    }
  }

  async function sendOutputPart(
    target: MessagingToolTarget,
    type: SendType,
    content: string,
    options: { transcript?: string; retry: boolean; skipWait?: boolean }
  ): Promise<SendPartResult> {
    if (!options.skipWait) await waitForMessageSendSlot(options.transcript ?? content);
    const output = buildOutput(target, type, content, options.transcript);
    const stored = deps.store.insertOutboundMessage(toStoredOutbound(output));
    try {
      markMessageAttemptedNow();
      const sent = await deps.outputRouter.send(output);
      const sentAt = time.now().iso;
      deps.store.markOutboundMessageSent(stored.id, extractSentMessageId(sent), sentAt);
      deps.appendMessageLog?.({
        direction: "outbound",
        plugin: output.target.plugin,
        kind: output.content.kind,
        target: output.target.channelId ?? output.target.userId,
        sessionId: output.target.sessionId,
        status: "sent",
        summary: summarizeOutput(output)
      });
      return { ok: true, messageId: extractSentMessageId(sent), content: options.transcript ?? content, storedId: stored.id };
    } catch (error) {
      const reason = normalizeSendError(error);
      deps.store.markOutboundMessageFailed(stored.id, time.now().iso, reason);
      deps.appendMessageLog?.({
        direction: "outbound",
        plugin: output.target.plugin,
        kind: output.content.kind,
        target: output.target.channelId ?? output.target.userId,
        sessionId: output.target.sessionId,
        status: "send_failed",
        summary: summarizeOutput(output),
        error: reason
      });
      if (options.retry) enqueueSendRetry({ output, storedId: stored.id, content });
      return { ok: false, error: reason, content: options.transcript ?? content, storedId: stored.id };
    }
  }

  function markMessageAttemptedNow(): void {
    lastMessageTimestampMs = time.now().epochMs;
  }

  function enqueueSendRetry(input: { output: AgentOutput; storedId: number; content: string }): void {
    retryQueue = retryQueue
      .then(() => retrySend(input))
      .catch((error) => {
        deps.appendMessageLog?.({
          direction: "outbound",
          plugin: input.output.target.plugin,
          kind: input.output.content.kind,
          target: input.output.target.channelId ?? input.output.target.userId,
          sessionId: input.output.target.sessionId,
          status: "retry_queue_failed",
          summary: summarizeOutput(input.output),
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  async function retrySend(input: { output: AgentOutput; storedId: number; content: string }): Promise<void> {
    let lastReason: string | undefined;
    for (let attempt = 1; attempt <= maxSendRetryAttempts; attempt += 1) {
      await waitForMessageSendSlot(input.content);
      try {
        markMessageAttemptedNow();
        const sent = await deps.outputRouter.send(input.output);
        const sentAt = time.now().iso;
        deps.store.markOutboundMessageSent(input.storedId, extractSentMessageId(sent), sentAt);
        deps.appendMessageLog?.({
          direction: "outbound",
          plugin: input.output.target.plugin,
          kind: input.output.content.kind,
          target: input.output.target.channelId ?? input.output.target.userId,
          sessionId: input.output.target.sessionId,
          status: "retry_sent",
          summary: summarizeOutput(input.output)
        });
        return;
      } catch (error) {
        const reason = normalizeSendError(error);
        lastReason = reason;
        deps.store.markOutboundMessageFailed(input.storedId, time.now().iso, reason);
      }
    }
    deps.appendMessageLog?.({
      direction: "outbound",
      plugin: input.output.target.plugin,
      kind: input.output.content.kind,
      target: input.output.target.channelId ?? input.output.target.userId,
      sessionId: input.output.target.sessionId,
      status: "retry_failed",
      summary: summarizeOutput(input.output),
      error: lastReason ? `retry failed after ${maxSendRetryAttempts} attempt(s): ${lastReason}` : `retry failed after ${maxSendRetryAttempts} attempt(s)`
    });
  }

  function resolveTarget(call: ToolCall): MessagingToolTarget | undefined {
    if (call.requester?.plugin && call.session?.sessionId) {
      return normalizeTarget({
        plugin: call.requester.plugin,
        accountId: call.requester.accountId,
        channelId: call.requester.channelId,
        userId: call.requester.userId,
        sessionId: call.session.sessionId
      });
    }
    const target = deps.getDefaultTarget?.();
    return target ? normalizeTarget(target) : undefined;
  }

  function normalizeTarget(target: MessagingToolTarget): MessagingToolTarget {
    if (target.plugin !== "feishu") return target;
    const normalizedChannelId = normalizeFeishuChatId(target.channelId);
    const normalizedUserId = normalizedChannelId ? target.userId : normalizeFeishuOpenId(target.userId ?? target.channelId);
    return {
      ...target,
      channelId: normalizedChannelId,
      userId: normalizedUserId
    };
  }

  function buildOutput(target: MessagingToolTarget, type: SendType, content: string, transcript?: string): AgentOutput {
    return {
      id: createId("tool_out"),
      target: {
        plugin: target.plugin,
        accountId: target.accountId,
        channelId: target.channelId,
        userId: target.userId,
        sessionId: target.sessionId
      },
      content: type === "markdown"
        ? { kind: "markdown", markdown: content }
        : type === "image"
          ? { kind: "image", assetId: content }
          : type === "voice"
            ? { kind: "audio", assetId: content, transcript }
            : { kind: "text", text: content },
      meta: {
        createdAt: time.now().iso,
        urgency: "normal",
        allowStreaming: false
      }
    };
  }

  function readShellSwitchContext(sinceDate: Date): ShellSwitchContextEntry[] {
    return (deps.getShellSwitchLogs?.() ?? [])
      .map((entry) => ({
        kind: "shell" as const,
        time: parseMessageTime(entry.time, time.timeZone),
        personalityName: entry.personalityName,
        relationshipName: entry.relationshipName
      }))
      .filter((entry) => entry.time.getTime() >= sinceDate.getTime());
  }
}

const checkChatTool: ToolDefinition = {
  name: "check_chat",
  description: "查看聊天记录。首次调用返回最近50条消息；后续调用只返回新增消息。",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
};

const sendChatTool: ToolDefinition = {
  name: "send_chat",
  description: "发送消息到当前聊天会话。必须先提供 type，再提供 content；type=message 和 type=voice 会把 content 中的换行拆成多条消息并间隔发送；type=voice 会把每段文本合成为语音并发送。",
  inputSchema: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["message", "markdown", "image", "voice"] },
      content: { type: "string" }
    },
    required: ["type", "content"],
    additionalProperties: false
  }
};

const searchMessagesTool: ToolDefinition = {
  name: "search_messages",
  description: "Search persisted messages in the current conversation and return contextual message blocks.",
  inputSchema: {
    type: "object",
    properties: {
      content: { type: "string" },
      direction: {
        type: "string",
        enum: ["backward", "forward", "从后到前", "从前到后"],
        default: "backward"
      },
      limit: { type: "integer", minimum: 1, maximum: 20, default: 3 },
      contextCount: { type: "integer", minimum: 1, maximum: 50, default: 10 }
    },
    required: ["content"],
    additionalProperties: false
  }
};

type ShellSwitchContextEntry = {
  kind: "shell";
  time: Date;
  personalityName: string;
  relationshipName: string;
};

type ChatContextEntry =
  | { kind: "message"; time: Date; message: StoredConversationMessage }
  | ShellSwitchContextEntry;

function formatTimelineBlocks(
  messages: StoredConversationMessage[],
  shellEvents: ShellSwitchContextEntry[],
  timeZone: string,
  userName: string
): string {
  const entries: ChatContextEntry[] = [
    ...messages.map((message) => ({ kind: "message" as const, time: parseMessageTime(message.createdAt, timeZone), message })),
    ...shellEvents
  ].sort((left, right) => left.time.getTime() - right.time.getTime());

  const blocks: string[] = [];
  let currentLines: string[] = [];
  let currentTime: Date | undefined;

  for (const entry of entries) {
    if (!currentTime || entry.time.getTime() - currentTime.getTime() >= 5 * 60 * 1000) {
      if (currentLines.length > 0) blocks.push(currentLines.join("\n"));
      currentTime = entry.time;
      currentLines = [`[${formatLocalDateTime(entry.time, timeZone)}]`];
    }
    currentLines.push(formatContextEntryLine(entry, userName));
  }

  if (currentLines.length > 0) blocks.push(currentLines.join("\n"));
  return blocks.join("\n");
}

function formatMessageBlocks(messages: StoredConversationMessage[], timeZone: string, userName: string, now: Date): string {
  const blocks: string[] = [];
  let currentLines: string[] = [];
  let currentTime: Date | undefined;

  for (const message of messages) {
    const messageTime = parseZonedIso(message.createdAt, timeZone);
    if (!currentTime || messageTime.getTime() - currentTime.getTime() >= 5 * 60 * 1000) {
      if (currentLines.length > 0) blocks.push(currentLines.join("\n"));
      currentTime = messageTime;
      currentLines = [`[${formatLocalDateTime(messageTime, timeZone)}]`];
    }
    currentLines.push(formatMessageContentLine(message, userName));
  }

  if (currentLines.length > 0) blocks.push(currentLines.join("\n"));
  return blocks.join("\n");
}

function formatContextEntryLine(entry: ChatContextEntry, userName: string): string {
  if (entry.kind === "shell") {
    return `-壳切换:切换为${entry.personalityName}的${entry.relationshipName}爱丽丝-`;
  }
  return formatMessageContentLine(entry.message, userName);
}

function appendCurrentTime(output: string, timeZone: string, date: Date): string {
  return `<chat-log>\n${output}\n</chat-log>\n<time>${formatLocalDateTime(date, timeZone)}<\\time>`;
}

function formatMessageContentLine(message: StoredConversationMessage, userName: string): string {
  const isSystem = isSystemPromptMessage(message);
  const speaker = message.direction === "outbound" || message.senderRole === "assistant"
      ? "Alice"
      : userName;
  const recalled = message.isRecalled ? "[已撤回]" : "";
  const sendStatus = !isSystem && message.direction === "outbound" && message.status === "send_failed"
    ? "[发送失败]"
    : !isSystem && message.direction === "outbound" && message.status === "sending"
      ? "[发送中]"
      : "";
  const reactions = summarizeReactions(message.reactionsJson);
  const content = `${message.isRecalled ? "(message recalled)" : formatMessageContent(message)}${sendStatus}${reactions ? `[reaction: ${reactions}]` : ""}${recalled}`;
  if (isSystem) return content;
  return isMediaActionMessage(message) ? `${speaker}${content}` : `${speaker}:${content}`;
}

function formatMessageContent(message: StoredConversationMessage): string {
  const content = parseContentJson(message.contentJson);
  if (message.contentType === "image" || content?.kind === "image") return "发送了一张图片";
  if (message.contentType === "audio" || content?.kind === "audio") {
    const transcript = optionalStringValue(content?.transcript) || message.contentText;
    return `[语音]${transcript}`;
  }
  if (message.contentType === "file" || content?.kind === "file") {
    const filePath = optionalStringValue(content?.filename) || optionalStringValue(content?.assetId) || message.contentText;
    return `发送了文件[${filePath}]`;
  }
  return message.contentText;
}

function isMediaActionMessage(message: StoredConversationMessage): boolean {
  const content = parseContentJson(message.contentJson);
  return message.contentType === "image"
    || content?.kind === "image"
    || message.contentType === "file"
    || content?.kind === "file";
}

function parseContentJson(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function optionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isSystemPromptMessage(message: StoredConversationMessage): boolean {
  if (message.senderRole === "system") return true;
  return [
    "-少女拍照中-",
    "-大失败-",
    "-星界信号丢失-",
    "(少女拍照中...)",
    "(大失败...)"
  ].includes(message.contentText);
}

function summarizeReactions(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, { count?: unknown }>;
    return Object.entries(parsed)
      .map(([emoji, value]) => `${emoji}:${typeof value.count === "number" ? value.count : 0}`)
      .filter((part) => !part.endsWith(":0"))
      .join(", ");
  } catch {
    return "";
  }
}

function contextSlice(messages: StoredConversationMessage[], hitIndex: number, contextCount: number): StoredConversationMessage[] {
  const before = Math.floor((contextCount - 1) / 2);
  const start = Math.max(0, Math.min(hitIndex - before, messages.length - contextCount));
  return messages.slice(start, start + contextCount);
}

function formatLocalDateTime(date: Date, timeZone: string): string {
  const values = localDateTimeParts(date, timeZone);
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

type LocalDateTimeStringParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
};

function localDateTimeParts(date: Date, timeZone: string): LocalDateTimeStringParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value])) as LocalDateTimeStringParts;
}

function shiftLocalDateParts(parts: Pick<LocalDateTimeStringParts, "year" | "month" | "day">, deltaDays: number): Pick<LocalDateTimeStringParts, "year" | "month" | "day"> {
  const shifted = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + deltaDays));
  return {
    year: String(shifted.getUTCFullYear()),
    month: String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    day: String(shifted.getUTCDate()).padStart(2, "0")
  };
}

function parseMessageTime(value: string, timeZone: string): Date {
  return parseZonedIso(value, timeZone);
}

function normalizeDirection(value: unknown): "forward" | "backward" {
  const text = stringValue(value);
  return text === "forward" || text === "从前到后" ? "forward" : "backward";
}

function normalizeSendType(value: unknown): SendType | undefined {
  const text = stringValue(value) || "message";
  if (text === "message" || text === "markdown" || text === "image" || text === "voice") return text;
  return undefined;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function normalizeFeishuChatId(value: string | undefined): string | undefined {
  const unwrapped = unwrapFeishuInternalId(value);
  if (!unwrapped) return undefined;
  return unwrapped.prefixed && !unwrapped.id.startsWith("oc_") ? undefined : unwrapped.id;
}

function normalizeFeishuOpenId(value: string | undefined): string | undefined {
  const unwrapped = unwrapFeishuInternalId(value);
  if (!unwrapped) return undefined;
  return unwrapped.prefixed && unwrapped.id.startsWith("oc_") ? undefined : unwrapped.id;
}

function unwrapFeishuInternalId(value: string | undefined): { id: string; prefixed: boolean } | undefined {
  if (!value) return undefined;
  const match = /^feishu:(?:dm|group):(.+)$/.exec(value);
  return match ? { id: match[1], prefixed: true } : { id: value, prefixed: false };
}

function toStoredOutbound(output: AgentOutput): InsertOutboundMessageInput {
  return {
    plugin: output.target.plugin,
    conversationId: output.target.sessionId,
    senderRole: "assistant",
    contentType: output.content.kind,
    contentText: summarizeOutput(output),
    contentJson: JSON.stringify(output.content),
    createdAt: output.meta.createdAt
  };
}

function summarizeOutput(output: AgentOutput): string {
  const content = output.content;
  if (content.kind === "text") return content.text;
  if (content.kind === "markdown") return content.markdown;
  if (content.kind === "audio") return content.transcript ? `[语音]${content.transcript}` : content.assetId;
  if (content.kind === "image") return content.assetId;
  if (content.kind === "file") return content.filename || content.assetId;
  if (content.kind === "card") return content.card.title;
  return content.kind;
}

function extractSentMessageId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { messageId?: unknown };
  return typeof record.messageId === "string" ? record.messageId : undefined;
}

function normalizeSendError(error: unknown): string {
  const record = isRecord(error) ? error : undefined;
  const response = isRecord(record?.response) ? record.response : undefined;
  const data = isRecord(response?.data) ? response.data : undefined;
  const nestedError = isRecord(data?.error) ? data.error : undefined;
  const code = data?.code ?? record?.code;
  const msg = typeof data?.msg === "string"
    ? data.msg
    : error instanceof Error
      ? error.message
      : typeof record?.message === "string"
        ? record.message
        : String(error);
  const logId = typeof data?.log_id === "string"
    ? data.log_id
    : typeof nestedError?.log_id === "string"
      ? nestedError.log_id
      : undefined;
  if (code !== undefined || data?.msg) {
    return `Feishu API${code !== undefined ? ` ${String(code)}` : ""}: ${msg}${logId ? ` log_id=${logId}` : ""}`;
  }
  if (response?.status !== undefined) {
    return `HTTP ${String(response.status)}: ${msg}`;
  }
  return msg;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function messageDelayForContent(content: string): number {
  const characterCount = Array.from(content.replace(/\s+/g, "")).length;
  return Math.min(maxMessageDelayMs, Math.max(minMessageDelayMs, characterCount * messageDelayMsPerCharacter));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toolError(call: ToolCall, error: string): ToolResult {
  return { callId: call.id, ok: false, error };
}

export type ConfiguredVoiceSynthesizerDeps = MossOnnxVoiceSynthesizerDeps;

export function createConfiguredVoiceSynthesizer(input?: TTSConfig, deps: ConfiguredVoiceSynthesizerDeps = {}): VoiceSynthesizer {
  const config = input ?? { backend: "genie-tts" as const };
  const moss = createMossOnnxVoiceSynthesizer({ ...config, backend: "moss-onnx" }, deps);
  if (config.backend === "moss-onnx") return moss;
  const genieReadinessError = getGenieReadinessError(config);
  if (genieReadinessError) {
    deps.appendLog?.("warn", `genie tts unavailable; falling back to moss: ${genieReadinessError}`);
    return moss;
  }
  const genie = createGenieTtsVoiceSynthesizer(config, deps);
  let genieHasSynthesized = false;
  let useMossFallback = false;
  const synthesize = (async (request) => {
    if (useMossFallback) return moss(request);
    try {
      const result = await genie(request);
      genieHasSynthesized = true;
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!genieHasSynthesized && isGenieStartupFallbackError(message)) {
        useMossFallback = true;
        deps.appendLog?.("warn", `genie tts startup failed; falling back to moss: ${message}`);
        return moss(request);
      }
      throw error;
    }
  }) as VoiceSynthesizer;
  synthesize.noteActivity = () => {
    if (!useMossFallback) genie.noteActivity?.();
    moss.noteActivity?.();
  };
  synthesize.prepare = async () => {
    if (useMossFallback) {
      await moss.prepare?.();
      return;
    }
    try {
      await genie.prepare?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isGenieStartupFallbackError(message)) {
        useMossFallback = true;
        deps.appendLog?.("warn", `genie tts prepare failed; falling back to moss: ${message}`);
        await moss.prepare?.();
        return;
      }
      throw error;
    }
  };
  synthesize.shutdown = async () => {
    await genie.shutdown?.();
    await moss.shutdown?.();
  };
  return synthesize;
}

function getGenieReadinessError(input: TTSConfig): string | undefined {
  if (input.genieBaseURLExplicit) return undefined;
  const dataDir = input.genieDataDir ?? "assets/tts/genie/GenieData";
  const modelDir = input.genieModelDir ?? "assets/tts/genie/models/alice";
  const referenceAudio = input.genieReferenceAudio ?? input.mossReferenceAudio ?? "assets/tts/references/alice/reference.wav";
  const referenceText = input.genieReferenceText ?? referenceTextPath(referenceAudio);
  const modelPath = resolveAssetScopedPath(modelDir);
  try {
    requireAssetDirectory(dataDir, "Genie TTS data directory was not found");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (!fs.existsSync(modelPath)) return `Genie model directory was not found: ${modelPath}`;
  if (!containsFileWithExtension(modelPath, ".onnx")) return `Genie model directory has no ONNX files: ${modelPath}`;
  try {
    requireAssetPath(referenceAudio, "Genie TTS reference audio was not found");
    requireAssetPath(referenceText, "Genie TTS reference text was not found");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

function containsFileWithExtension(dir: string, extension: string): boolean {
  try {
    for (const name of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, name);
      const stat = fs.statSync(fullPath);
      if (stat.isFile() && path.extname(name).toLowerCase() === extension) return true;
      if (!stat.isFile() && containsFileWithExtension(fullPath, extension)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function referenceTextPath(referenceAudio: string): string {
  return referenceAudio.replace(/\.[^./\\]+$/, "") + ".txt";
}

function isGenieStartupFallbackError(message: string): boolean {
  return /load|reference|not healthy|did not become healthy|exited before ready|model directory|reference text|reference audio/i.test(message);
}

export type MossOnnxVoiceSynthesizerDeps = {
  appendLog?(level: "info" | "warn" | "error", message: string): void;
  spawn?: typeof childProcess.spawn;
  fetch?: typeof fetch;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

export function createMossOnnxVoiceSynthesizer(input: TTSConfig, deps: MossOnnxVoiceSynthesizerDeps = {}): VoiceSynthesizer {
  const fetchImpl = deps.fetch ?? fetch;
  const spawnImpl = deps.spawn ?? childProcess.spawn;
  const setTimer = deps.setTimeout ?? setTimeout;
  const clearTimer = deps.clearTimeout ?? clearTimeout;
  const config = {
    baseURL: (input.mossBaseURL ?? `http://${input.mossHost ?? "127.0.0.1"}:${input.mossPort ?? 8765}`).replace(/\/+$/, ""),
    baseURLExplicit: input.mossBaseURLExplicit ?? Boolean(input.mossBaseURL),
    host: input.mossHost ?? "127.0.0.1",
    port: input.mossPort ?? 8765,
    pythonCommand: input.mossPythonCommand ?? ".conda-moss/bin/python",
    serviceScript: input.mossServiceScript ?? "scripts/moss_tts_onnx/service.py",
    modelDir: input.mossModelDir ?? "assets/tts/moss-onnx/models",
    referenceAudio: input.mossReferenceAudio ?? "assets/tts/references/alice/reference.wav",
    outputDir: input.mossOutputDir ?? "assets/generated/tts",
    timeoutMs: input.mossTimeoutMs ?? 120_000,
    idleShutdownMs: input.mossIdleShutdownMs ?? 15 * 60 * 1000,
    ffmpegCommand: input.mossFfmpegCommand ?? "ffmpeg-static",
    voiceCloneMaxTextTokens: input.mossVoiceCloneMaxTextTokens ?? 75
  };
  let ownedProcess: ReturnType<typeof childProcess.spawn> | undefined;
  let starting: Promise<void> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let serviceWasExternal = false;

  const synthesize = (async ({ text, time }) => {
    noteActivity();
    const outputDir = resolveAssetOutputDir(config.outputDir);
    fs.mkdirSync(outputDir.fullPath, { recursive: true });
    const baseName = uniqueVoiceBaseName(outputDir.fullPath, time.now().iso);
    const wavPath = path.resolve(outputDir.fullPath, `${baseName}.wav`);
    const opusPath = path.resolve(outputDir.fullPath, `${baseName}.opus`);
    const opusAssetId = path.join(outputDir.relativePath, `${baseName}.opus`);
    const referenceAudio = requireAssetPath(config.referenceAudio, "MOSS TTS reference audio was not found");
    await ensureMossService();
    try {
      const response = await postJson(`${config.baseURL}/synthesize`, {
        text,
        referenceAudioPath: referenceAudio,
        outputPath: wavPath,
        voiceCloneMaxTextTokens: config.voiceCloneMaxTextTokens
      }, config.timeoutMs, fetchImpl);
      if (!isRecord(response) || response.ok === false) {
        throw new Error(isRecord(response) ? optionalStringValue(response.error) || "MOSS TTS synthesize failed" : "MOSS TTS synthesize failed");
      }
      validateGeneratedVoice(wavPath, outputDir.fullPath);
      await validateVoiceLoudness(wavPath, config.ffmpegCommand, spawnImpl);
      await convertWavToOpus(wavPath, opusPath, config.ffmpegCommand, spawnImpl);
      validateGeneratedVoice(opusPath, outputDir.fullPath);
      await validateVoiceLoudness(opusPath, config.ffmpegCommand, spawnImpl);
      noteActivity();
      return { assetId: opusAssetId, filePath: opusPath };
    } finally {
      await removeGeneratedVoice(wavPath);
    }
  }) as VoiceSynthesizer;

  synthesize.noteActivity = noteActivity;
  synthesize.prepare = async () => {
    noteActivity();
    await ensureMossService();
  };
  synthesize.shutdown = shutdownOwnedService;
  return synthesize;

  function noteActivity(): void {
    if (idleTimer) clearTimer(idleTimer);
    if (config.idleShutdownMs <= 0) return;
    idleTimer = setTimer(() => {
      idleTimer = undefined;
      shutdownOwnedService().catch((error) => {
        deps.appendLog?.("warn", `moss tts idle shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, config.idleShutdownMs);
    idleTimer.unref?.();
  }

  async function ensureMossService(): Promise<void> {
    if (await isHealthy()) {
      serviceWasExternal = ownedProcess === undefined;
      return;
    }
    if (config.baseURLExplicit) {
      throw new Error(`MOSS TTS service is not healthy at ${config.baseURL}; custom MOSS_TTS_BASE_URL disables local auto-start`);
    }
    if (starting) {
      await starting;
      return;
    }
    starting = startOwnedService().finally(() => {
      starting = undefined;
    });
    await starting;
  }

  async function startOwnedService(): Promise<void> {
    const scriptPath = path.resolve(config.serviceScript);
    if (!fs.existsSync(scriptPath)) throw new Error(`MOSS TTS service script was not found: ${scriptPath}`);
    const modelDir = requireAssetPath(config.modelDir, "MOSS TTS model directory was not found");
    const outputDir = resolveAssetOutputDir(config.outputDir);
    fs.mkdirSync(outputDir.fullPath, { recursive: true });
    deps.appendLog?.("info", `moss tts service starting: ${config.pythonCommand} ${scriptPath}`);
    ownedProcess = spawnImpl(config.pythonCommand, [
      scriptPath,
      "--host", config.host,
      "--port", String(config.port),
      "--model-dir", modelDir,
      "--output-dir", outputDir.fullPath
    ], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    serviceWasExternal = false;
    ownedProcess.stdout?.on("data", (chunk: Buffer) => deps.appendLog?.("info", `moss tts: ${String(chunk).trim()}`));
    ownedProcess.stderr?.on("data", (chunk: Buffer) => deps.appendLog?.("warn", `moss tts: ${String(chunk).trim()}`));
    ownedProcess.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      deps.appendLog?.("info", `moss tts service exited: code=${code ?? ""} signal=${signal ?? ""}`);
      ownedProcess = undefined;
    });
    await waitForHealthy();
  }

  async function waitForHealthy(): Promise<void> {
    const deadline = Date.now() + config.timeoutMs;
    let lastError = "not ready";
    while (Date.now() < deadline) {
      if (ownedProcess?.exitCode !== null && ownedProcess?.exitCode !== undefined) {
        throw new Error(`MOSS TTS service exited before ready: ${ownedProcess.exitCode}`);
      }
      try {
        if (await isHealthy()) return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await delay(500);
    }
    throw new Error(`MOSS TTS service did not become healthy: ${lastError}`);
  }

  async function isHealthy(): Promise<boolean> {
    try {
      const response = await fetchImpl(`${config.baseURL}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(Math.min(2_000, config.timeoutMs))
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function shutdownOwnedService(): Promise<void> {
    if (idleTimer) {
      clearTimer(idleTimer);
      idleTimer = undefined;
    }
    if (!ownedProcess || serviceWasExternal) return;
    const processToStop = ownedProcess;
    try {
      await postJson(`${config.baseURL}/shutdown`, {}, 2_000, fetchImpl);
    } catch {
      processToStop.kill("SIGTERM");
    }
  }
}

export function createGenieTtsVoiceSynthesizer(input: TTSConfig, deps: MossOnnxVoiceSynthesizerDeps = {}): VoiceSynthesizer {
  const fetchImpl = deps.fetch ?? fetch;
  const spawnImpl = deps.spawn ?? childProcess.spawn;
  const setTimer = deps.setTimeout ?? setTimeout;
  const clearTimer = deps.clearTimeout ?? clearTimeout;
  const referenceAudioConfig = input.genieReferenceAudio ?? input.mossReferenceAudio ?? "assets/tts/references/alice/reference.wav";
  const config = {
    baseURL: (input.genieBaseURL ?? `http://${input.genieHost ?? "127.0.0.1"}:${input.geniePort ?? 8767}`).replace(/\/+$/, ""),
    baseURLExplicit: input.genieBaseURLExplicit ?? Boolean(input.genieBaseURL),
    host: input.genieHost ?? "127.0.0.1",
    port: input.geniePort ?? 8767,
    pythonCommand: input.geniePythonCommand ?? input.mossPythonCommand ?? ".conda-moss/bin/python",
    serviceScript: input.genieServiceScript ?? "scripts/genie_tts/service.py",
    dataDir: input.genieDataDir ?? "assets/tts/genie/GenieData",
    modelDir: input.genieModelDir ?? "assets/tts/genie/models/alice",
    characterName: input.genieCharacterName ?? "alice",
    language: input.genieLanguage ?? "zh",
    referenceAudio: referenceAudioConfig,
    referenceText: input.genieReferenceText ?? referenceTextPath(referenceAudioConfig),
    outputDir: input.genieOutputDir ?? input.mossOutputDir ?? "assets/generated/tts",
    timeoutMs: input.genieTimeoutMs ?? input.mossTimeoutMs ?? 120_000,
    idleShutdownMs: input.genieIdleShutdownMs ?? input.mossIdleShutdownMs ?? 15 * 60 * 1000,
    ffmpegCommand: input.genieFfmpegCommand ?? input.mossFfmpegCommand ?? "ffmpeg-static"
  };
  let ownedProcess: ReturnType<typeof childProcess.spawn> | undefined;
  let starting: Promise<void> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let serviceWasExternal = false;

  const synthesize = (async ({ text, time }) => {
    noteActivity();
    const outputDir = resolveAssetOutputDir(config.outputDir);
    fs.mkdirSync(outputDir.fullPath, { recursive: true });
    const baseName = uniqueVoiceBaseName(outputDir.fullPath, time.now().iso);
    const wavPath = path.resolve(outputDir.fullPath, `${baseName}.wav`);
    const opusPath = path.resolve(outputDir.fullPath, `${baseName}.opus`);
    const opusAssetId = path.join(outputDir.relativePath, `${baseName}.opus`);
    await ensureGenieService();
    try {
      const response = await postJson(`${config.baseURL}/synthesize`, {
        text,
        outputPath: wavPath
      }, config.timeoutMs, fetchImpl, "Genie TTS");
      if (!isRecord(response) || response.ok === false) {
        throw new Error(isRecord(response) ? optionalStringValue(response.error) || "Genie TTS synthesize failed" : "Genie TTS synthesize failed");
      }
      validateGeneratedVoice(wavPath, outputDir.fullPath);
      await validateVoiceLoudness(wavPath, config.ffmpegCommand, spawnImpl);
      await convertWavToOpus(wavPath, opusPath, config.ffmpegCommand, spawnImpl);
      validateGeneratedVoice(opusPath, outputDir.fullPath);
      await validateVoiceLoudness(opusPath, config.ffmpegCommand, spawnImpl);
      noteActivity();
      return { assetId: opusAssetId, filePath: opusPath };
    } finally {
      await removeGeneratedVoice(wavPath);
    }
  }) as VoiceSynthesizer;

  synthesize.noteActivity = noteActivity;
  synthesize.prepare = async () => {
    noteActivity();
    await ensureGenieService();
  };
  synthesize.shutdown = shutdownOwnedService;
  return synthesize;

  function noteActivity(): void {
    if (idleTimer) clearTimer(idleTimer);
    if (config.idleShutdownMs <= 0) return;
    idleTimer = setTimer(() => {
      idleTimer = undefined;
      shutdownOwnedService().catch((error) => {
        deps.appendLog?.("warn", `genie tts idle shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, config.idleShutdownMs);
    idleTimer.unref?.();
  }

  async function ensureGenieService(): Promise<void> {
    if (await isHealthy()) {
      serviceWasExternal = ownedProcess === undefined;
      return;
    }
    if (config.baseURLExplicit) {
      throw new Error(`Genie TTS service is not healthy at ${config.baseURL}; custom GENIE_TTS_BASE_URL disables local auto-start`);
    }
    if (starting) {
      await starting;
      return;
    }
    starting = startOwnedService().finally(() => {
      starting = undefined;
    });
    await starting;
  }

  async function startOwnedService(): Promise<void> {
    const scriptPath = path.resolve(config.serviceScript);
    if (!fs.existsSync(scriptPath)) throw new Error(`Genie TTS service script was not found: ${scriptPath}`);
    const dataDir = requireAssetDirectory(config.dataDir, "Genie TTS data directory was not found");
    const modelDir = requireAssetDirectory(config.modelDir, "Genie TTS model directory was not found");
    const referenceAudio = requireAssetPath(config.referenceAudio, "Genie TTS reference audio was not found");
    const referenceText = requireAssetPath(config.referenceText, "Genie TTS reference text was not found");
    const outputDir = resolveAssetOutputDir(config.outputDir);
    fs.mkdirSync(outputDir.fullPath, { recursive: true });
    deps.appendLog?.("info", `genie tts service starting: ${config.pythonCommand} ${scriptPath}`);
    ownedProcess = spawnImpl(config.pythonCommand, [
      scriptPath,
      "--host", config.host,
      "--port", String(config.port),
      "--model-dir", modelDir,
      "--output-dir", outputDir.fullPath,
      "--character-name", config.characterName,
      "--language", config.language,
      "--reference-audio", referenceAudio,
      "--reference-text", referenceText
    ], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GENIE_DATA_DIR: dataDir }
    });
    serviceWasExternal = false;
    ownedProcess.stdout?.on("data", (chunk: Buffer) => deps.appendLog?.("info", `genie tts: ${String(chunk).trim()}`));
    ownedProcess.stderr?.on("data", (chunk: Buffer) => deps.appendLog?.("warn", `genie tts: ${String(chunk).trim()}`));
    ownedProcess.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      deps.appendLog?.("info", `genie tts service exited: code=${code ?? ""} signal=${signal ?? ""}`);
      ownedProcess = undefined;
    });
    await waitForHealthy();
  }

  async function waitForHealthy(): Promise<void> {
    const deadline = Date.now() + config.timeoutMs;
    let lastError = "not ready";
    while (Date.now() < deadline) {
      if (ownedProcess?.exitCode !== null && ownedProcess?.exitCode !== undefined) {
        throw new Error(`Genie TTS service exited before ready: ${ownedProcess.exitCode}`);
      }
      try {
        if (await isHealthy()) return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await delay(500);
    }
    throw new Error(`Genie TTS service did not become healthy: ${lastError}`);
  }

  async function isHealthy(): Promise<boolean> {
    try {
      const response = await fetchImpl(`${config.baseURL}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(Math.min(2_000, config.timeoutMs))
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function shutdownOwnedService(): Promise<void> {
    if (idleTimer) {
      clearTimer(idleTimer);
      idleTimer = undefined;
    }
    if (!ownedProcess || serviceWasExternal) return;
    const processToStop = ownedProcess;
    try {
      await postJson(`${config.baseURL}/shutdown`, {}, 2_000, fetchImpl, "Genie TTS");
    } catch {
      processToStop.kill("SIGTERM");
    }
  }
}

async function postJson(url: string, body: Record<string, unknown>, timeoutMs: number, fetchImpl: typeof fetch, label = "MOSS TTS"): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = { text };
    }
  }
  if (!response.ok) {
    const message = isRecord(parsed) ? optionalStringValue(parsed.error) || optionalStringValue(parsed.text) : undefined;
    throw new Error(`${label} HTTP ${response.status}: ${(message ?? text).slice(0, 500)}`);
  }
  return parsed ?? {};
}

async function convertWavToOpus(wavPath: string, opusPath: string, ffmpegCommand: string, spawnImpl: typeof childProcess.spawn): Promise<void> {
  const resolvedFfmpegCommand = resolveFfmpegCommand(ffmpegCommand);
  await new Promise<void>((resolve, reject) => {
    const child = spawnImpl(resolvedFfmpegCommand, [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-i", wavPath,
      "-acodec", "libopus",
      "-b:a", "32k",
      "-vbr", "on",
      opusPath
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      const code = isRecord(error) ? error.code : undefined;
      reject(new Error(code === "ENOENT"
        ? `ffmpeg was not found; install ffmpeg-static or set MOSS_TTS_FFMPEG_COMMAND to enable opus audio`
        : error.message));
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg failed with exit code ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

async function readPcmStats(audioPath: string, ffmpegCommand: string, spawnImpl: typeof childProcess.spawn): Promise<{ rms: number; peak: number }> {
  const resolvedFfmpegCommand = resolveFfmpegCommand(ffmpegCommand);
  const chunks: Uint8Array[] = [];
  await new Promise<void>((resolve, reject) => {
    const child = spawnImpl(resolvedFfmpegCommand, [
      "-hide_banner",
      "-loglevel", "error",
      "-i", audioPath,
      "-f", "s16le",
      "-acodec", "pcm_s16le",
      "-"
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout?.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Uint8Array) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => reject(error));
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg failed to inspect audio loudness for ${audioPath}: ${stderr.slice(0, 500)}`));
    });
  });
  const pcm = concatUint8Arrays(chunks);
  if (pcm.length < 2) return { rms: 0, peak: 0 };
  let sumSquares = 0;
  let peak = 0;
  const samples = Math.floor(pcm.length / 2);
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const sample = readInt16LE(pcm, offset) / 32768;
    const abs = Math.abs(sample);
    peak = Math.max(peak, abs);
    sumSquares += sample * sample;
  }
  return { rms: Math.sqrt(sumSquares / samples), peak };
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function readInt16LE(bytes: Uint8Array, offset: number): number {
  const value = bytes[offset] | (bytes[offset + 1] << 8);
  return value & 0x8000 ? value - 0x10000 : value;
}

async function validateVoiceLoudness(audioPath: string, ffmpegCommand: string, spawnImpl: typeof childProcess.spawn): Promise<void> {
  const stats = await readPcmStats(audioPath, ffmpegCommand, spawnImpl);
  if (stats.rms < 0.005 || stats.peak < 0.03) {
    throw new Error(`Generated voice is too quiet: rms=${stats.rms.toFixed(6)} peak=${stats.peak.toFixed(6)} file=${path.basename(audioPath)}`);
  }
}

function resolveFfmpegCommand(ffmpegCommand: string): string {
  if (ffmpegCommand !== "ffmpeg-static") return ffmpegCommand;
  try {
    const resolved = require("ffmpeg-static") as unknown;
    if (typeof resolved === "string" && resolved) return resolved;
  } catch {
    // Fall through to a clear error below.
  }
  throw new Error("ffmpeg-static is not installed or did not expose an ffmpeg binary path");
}

function requireAssetPath(assetId: string, error: string): string {
  const assetRoot = path.resolve("assets");
  const filePath = resolveAssetScopedPath(assetId);
  const relative = path.relative(assetRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("TTS asset path is outside assets directory");
  if (!fs.existsSync(filePath)) throw new Error(error);
  return filePath;
}

function requireAssetDirectory(assetId: string, error: string): string {
  const dirPath = requireAssetPath(assetId, error);
  if (fs.statSync(dirPath).isFile()) throw new Error(error);
  return dirPath;
}

function resolveAssetOutputDir(assetDir: string): { fullPath: string; relativePath: string } {
  const assetRoot = path.resolve("assets");
  const fullPath = resolveAssetScopedPath(assetDir);
  const relativePath = path.relative(assetRoot, fullPath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("TTS output directory must be inside assets");
  }
  return { fullPath, relativePath };
}

function resolveAssetScopedPath(assetPath: string): string {
  if (path.isAbsolute(assetPath)) return assetPath;
  const normalized = path.normalize(assetPath);
  if (normalized === "assets" || normalized.startsWith(`assets${path.sep}`)) {
    return path.resolve(normalized);
  }
  return path.resolve("assets", normalized);
}

function validateGeneratedVoice(filePath: string, outputDir: string): void {
  const relative = path.relative(outputDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("TTS output file is outside output directory");
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error("TTS output is not a file");
  if (stat.size <= 0) throw new Error("TTS output file is empty");
}

function uniqueVoiceBaseName(outputDir: string, iso: string): string {
  const baseName = formatFileDateTime(iso);
  let candidate = baseName;
  let suffix = 2;
  while (fs.existsSync(path.join(outputDir, `${candidate}.wav`)) || fs.existsSync(path.join(outputDir, `${candidate}.opus`))) {
    candidate = `${baseName}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function removeGeneratedVoice(filePath: string): Promise<void> {
  try {
    await fsp.unlink(filePath);
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }
}

function formatFileDateTime(value: string): string {
  return value.replace(/[-:]/g, "").replace("T", "_").replace(".", "_");
}
