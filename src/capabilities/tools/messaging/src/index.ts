import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import { createCurrentTimeProvider } from "../../../../platform/time/src/index.js";
import { todayMessagingAnchor } from "../../../../platform/time/src/index.js";
import { parseZonedIso } from "../../../../platform/time/src/index.js";
import type { OutputRouter } from "../../../../platform/output-router/src/index.js";
import type { AgentOutput, ToolCall, ToolDefinition, ToolPlugin, ToolResult } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { ToolOutputTargetResolver } from "../../../../contexts/capabilities/src/tool-output-target.js";
import { createId } from "../../../../shared/uuid/src/index.js";
import { sanitizeMessageText, summarizeAudioText } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { VoiceSynthesisResult, VoiceSynthesizer } from "../../../../channels/tts/src/index.js";
import type {
  AliceStore,
  InsertOutboundMessageInput,
  StoredConversationMessage
} from "../../../../contexts/conversation-hub/src/ports/conversation-store.js";

const fsp = await import("node:fs/promises");
const path = await import("node:path");

export * from "./sent-message-utils.js";

export type MessagingToolTarget = {
  plugin: string;
  accountId?: string;
  channelId?: string;
  userId?: string;
  sessionId: string;
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
  voiceSynthesizer?: VoiceSynthesizer;
  voiceMessageTtsTrainingOutputDir?: string;
  wechatVoiceFallbackToText?: boolean;
  getUserName?: () => string;
  getDefaultTarget?(): MessagingToolTarget | undefined;
  resolveOutputTarget?: ToolOutputTargetResolver;
  getShellSwitchLogs?(): Array<{
    time: string;
    personalityName: string;
    relationshipName: string;
  }>;
  getSleepCocoonEnteredAt?(): string | undefined;
  getActiveMainLLMSession?(): { generation: number; phase: "idle" | "running" | "cancelled" } | undefined;
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
const todaySleepContextMessageCount = 10;
const userSpeakerPlaceholder = "{{user}}";
type SendType = "message" | "markdown" | "image" | "voice";
type SendPartResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
  content: string;
  storedId?: number;
};

export function formatCheckChatMessages(
  messages: StoredConversationMessage[],
  options: {
    shellEvents?: ShellSwitchContextEntry[];
    timeZone: string;
    userName: string;
  }
): string {
  return messages.length > 0 || (options.shellEvents?.length ?? 0) > 0
    ? formatTimelineBlocks(messages, options.shellEvents ?? [], options.timeZone, options.userName)
    : "nothing new";
}

export function createMessagingTools(deps: MessagingToolsDeps): MessagingToolPlugin {
  const time = deps.time ?? createCurrentTimeProvider("UTC");
  const userName = () => deps.getUserName?.() || "user";
  const sleep = deps.sleep ?? delay;
  const voiceSynthesizer = deps.voiceSynthesizer ?? missingVoiceSynthesizer();
  const shouldPrepareVoiceSynthesizer = Boolean(deps.voiceSynthesizer);
  let lastMessageTimestampMs: number | undefined;
  let observedMainLLMSessionGeneration: number | undefined;
  let checkChatCallsInObservedMainLLMSession = 0;
  let retryQueue = Promise.resolve();

  return {
    id: "messaging",
    noteLLMRequestStarted() {
      lastMessageTimestampMs = time.now().epochMs;
      voiceSynthesizer.noteActivity?.();
      if (shouldPrepareVoiceSynthesizer) {
        voiceSynthesizer.prepare?.().catch((error) => {
          deps.appendLog?.("warn", `voice tts prepare failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    },
    noteLLMSessionCompleted() {
    },
    listTools() {
      return [checkChatTool, sendChatTool, waitChatTool];
    },
    async execute(call) {
      if (call.toolName === "check_chat" || call.toolName === "check_feishu" || call.toolName === "check_wechat" || call.toolName === "view_messages") return viewMessages(call);
      if (call.toolName === "send_chat" || call.toolName === "send_feishu" || call.toolName === "send_wechat" || call.toolName === "send_message") return sendMessage(call);
      if (call.toolName === "wait_chat") return waitChat(call);
      if (call.toolName === "search_messages") return searchMessages(call);
      return { callId: call.id, ok: false, error: `Unknown messaging tool: ${call.toolName}` };
    }
  };

  async function viewMessages(call: ToolCall): Promise<ToolResult> {
    const target = resolveTarget(call);
    if (!target) return toolError(call, "No current messaging session is available");
    return viewMessagesForScope(call.id, target, resolveViewScope(call.input.scope ?? call.input.__scope), {
      readonly: call.input.__preview === true,
      fromPrefixAfterMessageId: integerValue(call.input.__fromPrefixAfterMessageId),
      from: optionalStringValue(call.input.from),
      to: optionalStringValue(call.input.to)
    });
  }

  function viewMessagesForScope(
    callId: string,
    target: MessagingToolTarget,
    scope: "recent" | "today" | "todayold" | "new" | "from_prefix" | "range",
    options: { readonly?: boolean; fromPrefixAfterMessageId?: number; from?: string; to?: string } = {}
  ): ToolResult {
    const all = deps.store.listMessages(checkChatMessageLimit);
    const cursorMessageId = all.reduce((max, message) => Math.max(max, message.id), 0);
    let messages: StoredConversationMessage[];
    let sinceDate: Date;
    if (scope === "recent") {
      messages = all.slice(-recentCheckChatMessageCount);
      sinceDate = messages.length > 0 ? parseMessageTime(messages[0].createdAt, time.timeZone) : new Date(0);
    } else if (scope === "from_prefix") {
      const afterId = options.fromPrefixAfterMessageId ?? 0;
      messages = all.filter((message) => message.id > afterId);
      sinceDate = messages.length > 0 ? parseMessageTime(messages[0].createdAt, time.timeZone) : time.now().date;
    } else if (scope === "range") {
      const fromMs = options.from ? parseMessageTime(options.from, time.timeZone).getTime() : Number.NEGATIVE_INFINITY;
      const toMs = options.to ? parseMessageTime(options.to, time.timeZone).getTime() : Number.POSITIVE_INFINITY;
      messages = all.filter((message) => {
        const createdMs = parseMessageTime(message.createdAt, time.timeZone).getTime();
        return createdMs >= fromMs && createdMs < toMs;
      });
      sinceDate = Number.isFinite(fromMs)
        ? new Date(fromMs)
        : messages.length > 0
          ? parseMessageTime(messages[0].createdAt, time.timeZone)
          : time.now().date;
    } else if (scope === "new") {
      const firstUnread = all.find((message) => message.direction === "inbound" && message.senderRole === "user" && !message.isRead);
      sinceDate = firstUnread ? parseMessageTime(firstUnread.createdAt, time.timeZone) : new Date(0);
      messages = firstUnread ? all.filter((message) => message.id >= firstUnread.id) : [];
    } else if (scope === "today") {
      const sleepCocoonEnteredAt = deps.getSleepCocoonEnteredAt?.();
      const sleepCocoonDate = sleepCocoonEnteredAt ? parseMessageTime(sleepCocoonEnteredAt, time.timeZone) : undefined;
      if (sleepCocoonDate) {
        const sleepCocoonMs = sleepCocoonDate.getTime();
        const firstAfterSleepIndex = all.findIndex((message) => parseMessageTime(message.createdAt, time.timeZone).getTime() >= sleepCocoonMs);
        const boundaryIndex = firstAfterSleepIndex === -1 ? all.length : firstAfterSleepIndex;
        const startIndex = Math.max(0, boundaryIndex - todaySleepContextMessageCount);
        messages = all.slice(startIndex);
        sinceDate = messages.length > 0 ? parseMessageTime(messages[0].createdAt, time.timeZone) : sleepCocoonDate;
      } else {
        sinceDate = time.now().date;
        messages = [];
      }
    } else {
      const after = todayMessagingAnchor(time.timeZone, time.now().date).getTime();
      sinceDate = new Date(after);
      messages = all.filter((message) => parseMessageTime(message.createdAt, time.timeZone).getTime() >= after);
    }

    const shellEvents = scope === "new" && messages.length === 0 ? [] : readShellSwitchContext(sinceDate);
    if (!options.readonly) markViewedUserMessages(messages);
    const body = formatCheckChatMessages(messages, { shellEvents, timeZone: time.timeZone, userName: userSpeakerPlaceholder });
    return {
      callId,
      ok: true,
      messageCursorId: cursorMessageId,
      output: appendCurrentTime(body, time.now().iso)
    };
  }

  function resolveViewScope(scopeHint?: unknown): "recent" | "today" | "todayold" | "new" | "from_prefix" | "range" {
    if (scopeHint === "recent") return "recent";
    if (scopeHint === "today") return "today";
    if (scopeHint === "todayold") return "todayold";
    if (scopeHint === "new") return "new";
    if (scopeHint === "from_prefix") return "from_prefix";
    if (scopeHint === "range") return "range";
    const mainSession = deps.getActiveMainLLMSession?.();
    if (mainSession?.phase === "running") {
      if (observedMainLLMSessionGeneration !== mainSession.generation) {
        observedMainLLMSessionGeneration = mainSession.generation;
        checkChatCallsInObservedMainLLMSession = 0;
      }
      checkChatCallsInObservedMainLLMSession += 1;
      return checkChatCallsInObservedMainLLMSession === 1 ? "today" : "new";
    }
    return "today";
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
        messages: formatMessageBlocks(context, time.timeZone, userSpeakerPlaceholder, currentDate)
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

  function waitChat(call: ToolCall): ToolResult {
    return {
      callId: call.id,
      ok: true,
      meta: { yieldReturn: true }
    };
  }

  async function sendMessage(call: ToolCall): Promise<ToolResult> {
    const target = resolveTarget(call);
    if (!target) return toolError(call, "No current messaging session is available");
    const type = normalizeSendType(call.input.type);
    if (!type) return toolError(call, "unsupported message type");
    const rawContent = stringValue(call.input.content);
    const content = type === "message" || type === "voice"
      ? filterParentheticalSendContent(rawContent)
      : rawContent;
    if (!content.trim()) return toolError(call, "content is required");
    const parts = type === "message" || type === "voice"
      ? splitSendContentParts(content)
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
      output: appendCurrentTime(output || "nothing new", time.now().iso)
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
    if (target.plugin === "wechat" && deps.wechatVoiceFallbackToText !== false) {
      deps.appendLog?.("info", `wechat voice fallback to text: chars=${Array.from(text).length}`);
      return [await sendOutputPart(target, "message", text, { retry: true, skipWait: true })];
    }
    let synthesized: VoiceSynthesisResult | undefined;
    try {
      deps.appendLog?.("info", `voice tts start: chars=${Array.from(text).length}`);
      synthesized = await voiceSynthesizer({ text, time });
      const audioResult = await sendOutputPart(target, "voice", synthesized.assetId, { transcript: text, retry: false, skipWait: true });
      await archiveVoiceMessageTtsOutput(target, text, synthesized, audioResult.ok ? "sent" : "failed");
      if (target.plugin !== "feishu" || !audioResult.ok) return [audioResult];
      await sendFeishuVoiceTranscript(target, text);
      return [audioResult];
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

  async function archiveVoiceMessageTtsOutput(
    target: MessagingToolTarget,
    text: string,
    synthesized: VoiceSynthesisResult,
    status: "sent" | "failed"
  ): Promise<void> {
    try {
      const filePath = await copyVoiceMessageTrainingAsset({
        outputDir: deps.voiceMessageTtsTrainingOutputDir ?? "assets/generated/tts-training/voice-massage",
        text,
        target,
        synthesized,
        status,
        archivedAt: time.now().iso
      });
      deps.appendLog?.("info", `voice message tts archived: ${filePath}`);
    } catch (error) {
      deps.appendLog?.("warn", `voice message tts archive failed: ${error instanceof Error ? error.message : String(error)}`);
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
      deps.store.markOutboundMessageSent(stored.id, extractSentMessageId(sent), time.now().date.toISOString(), extractSentMessageCreatedAtUtc(sent));
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
      const failedTime = time.now();
      deps.store.markOutboundMessageFailed(stored.id, failedTime.iso, reason, failedTime.date.toISOString());
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

  async function sendFeishuVoiceTranscript(target: MessagingToolTarget, text: string): Promise<void> {
    const output = buildOutput(target, "message", `[${text}]`);
    let lastReason = "";
    for (let attempt = 1; attempt <= maxSendRetryAttempts; attempt += 1) {
      try {
        await deps.outputRouter.send(output);
        return;
      } catch (error) {
        lastReason = normalizeSendError(error);
        if (attempt < maxSendRetryAttempts) await sleep(Math.min(1000, attempt * 100));
      }
    }
    deps.appendLog?.("warn", `feishu voice transcript send failed: ${lastReason || "unknown error"}`);
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
        deps.store.markOutboundMessageSent(input.storedId, extractSentMessageId(sent), time.now().date.toISOString(), extractSentMessageCreatedAtUtc(sent));
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
        const failedTime = time.now();
        deps.store.markOutboundMessageFailed(input.storedId, failedTime.iso, reason, failedTime.date.toISOString());
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
    const resolved = deps.resolveOutputTarget?.(call);
    if (resolved) return normalizeTarget(resolved);
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
    const now = time.now();
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
        createdAt: now.iso,
        createdAtUtc: now.date.toISOString(),
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
  description: "查看聊天记录。首次调用默认返回从最近一次睡眠附近开始的消息；后续调用只返回新增消息。",
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

const waitChatTool: ToolDefinition = {
  name: "wait_chat",
  description: "等待聊天记录更新。当有新消息时会收到提醒并返回新消息。",
  inputSchema: {
    type: "object",
    properties: {},
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

type VoiceCallTranscriptRow = {
  sessionId: string;
  entryId?: string;
  role: "system" | "assistant" | "user";
  contentText: string;
  durationMs?: number;
};

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
  return formatTimelineEntries(entries, timeZone, userName);
}

function formatMessageBlocks(messages: StoredConversationMessage[], timeZone: string, userName: string, now: Date): string {
  const entries: ChatContextEntry[] = messages.map((message) => ({
    kind: "message" as const,
    time: parseZonedIso(message.createdAt, timeZone),
    message
  }));
  return formatTimelineEntries(entries, timeZone, userName);
}

function formatTimelineEntries(entries: ChatContextEntry[], timeZone: string, userName: string): string {
  const blocks: string[] = [];
  let currentLines: string[] = [];
  let currentTime: Date | undefined;
  let activeCall: { sessionId: string; lines: string[]; durationMs?: number; currentSpeaker?: string } | undefined;

  const flushChatBlock = () => {
    if (currentLines.length > 0) {
      blocks.push(currentLines.join("\n"));
      currentLines = [];
      currentTime = undefined;
    }
  };
  const flushActiveCall = () => {
    if (activeCall) {
      activeCall.lines.push("</voice-call-transcript>");
      blocks.push(activeCall.lines.join("\n"));
      activeCall = undefined;
    }
  };

  for (const entry of entries) {
    if (entry.kind === "message" && isVoiceCallTranscriptMessage(entry.message)) {
      flushChatBlock();
      const transcript = parseVoiceCallTranscriptMessage(entry.message);
      if (!transcript) continue;
      if (!activeCall || activeCall.sessionId !== transcript.sessionId) {
        flushActiveCall();
        activeCall = {
          sessionId: transcript.sessionId,
          durationMs: transcript.durationMs,
          lines: ["<voice-call-transcript>", `[${formatLocalDateTime(entry.time, timeZone)}]`]
        };
      }
      activeCall.durationMs = transcript.durationMs ?? activeCall.durationMs;
      appendVoiceCallTranscriptRow(activeCall, transcript, userName);
      if (transcript.role === "system" && transcript.contentText.trim() === "结束") {
        activeCall.lines.push(`<call-duration>${formatDurationMs(activeCall.durationMs)}</call-duration>`);
        flushActiveCall();
      }
      continue;
    }

    if (activeCall && entry.kind === "message") {
      activeCall.currentSpeaker = undefined;
      activeCall.lines.push(`[message]${formatMessageContentLine(entry.message, userName)}`);
      continue;
    }

    if (activeCall) flushActiveCall();

    if (!currentTime || entry.time.getTime() - currentTime.getTime() >= 5 * 60 * 1000) {
      if (currentLines.length > 0) {
        blocks.push(currentLines.join("\n"));
      }
      currentTime = entry.time;
      currentLines = [`[${formatLocalDateTime(entry.time, timeZone)}]`];
    }
    currentLines.push(formatContextEntryLine(entry, userName));
  }

  flushChatBlock();
  flushActiveCall();
  return blocks.join("\n");
}

function formatContextEntryLine(entry: ChatContextEntry, userName: string): string {
  if (entry.kind === "shell") {
    return `-壳切换:切换为${entry.personalityName}的${entry.relationshipName}爱丽丝-`;
  }
  return formatMessageContentLine(entry.message, userName);
}

function appendCurrentTime(output: string, currentTime: string): string {
  return `<chat-log>\n${output}\n</chat-log>\n<time>${currentTime}<\\time>`;
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
  if (isVoiceCallTranscriptMessage(message)) return message.contentText;
  if (message.contentType === "image" || content?.kind === "image") return "发送了一张图片";
  if (message.contentType === "audio" || content?.kind === "audio") {
    const transcript = optionalStringValue(content?.transcript) || message.contentText;
    return summarizeAudioText(transcript, message.contentText);
  }
  if (message.contentType === "file" || content?.kind === "file") {
    const filePath = optionalStringValue(content?.filename) || optionalStringValue(content?.assetId) || message.contentText;
    return `发送了文件[${filePath}]`;
  }
  return message.contentText;
}

function isVoiceCallTranscriptMessage(message: StoredConversationMessage): boolean {
  const content = parseContentJson(message.contentJson);
  return message.contentType === "voicecalltranscript" || content?.kind === "voicecalltranscript";
}

function parseVoiceCallTranscriptMessage(message: StoredConversationMessage): VoiceCallTranscriptRow | undefined {
  const payload = parseContentJson(message.contentJson);
  if (!payload || payload.kind !== "voicecalltranscript") return undefined;
  const role = transcriptRole(payload.role);
  const sessionId = optionalStringValue(payload.talkSessionId) || optionalStringValue(payload.sessionId) || message.conversationId;
  if (!role || !sessionId) return undefined;
  return {
    sessionId,
    entryId: optionalStringValue(payload.entryId),
    role,
    contentText: message.contentText,
    durationMs: numberValue(payload.durationMs)
  };
}

function transcriptRole(value: unknown): VoiceCallTranscriptRow["role"] | undefined {
  return value === "system" || value === "assistant" || value === "user" ? value : undefined;
}

function appendVoiceCallTranscriptRow(
  activeCall: { lines: string[]; currentSpeaker?: string },
  row: VoiceCallTranscriptRow,
  userName: string
): void {
  if (row.role === "system") {
    const text = row.contentText.trim();
    activeCall.currentSpeaker = undefined;
    if (text === "开始") activeCall.lines.push("-已接通-");
    else if (text === "结束") activeCall.lines.push("-已挂断-");
    else if (text) activeCall.lines.push(text);
    return;
  }

  const speaker = row.role === "assistant" ? "Alice" : userName;
  const lines = row.contentText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return;
  if (activeCall.currentSpeaker !== speaker) {
    activeCall.lines.push(`${speaker}:`);
    activeCall.currentSpeaker = speaker;
  }
  activeCall.lines.push(...lines);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatDurationMs(durationMs: number | undefined): string {
  if (durationMs === undefined) return "unknown";
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${pad2(minutes)}:${pad2(seconds)}`
    : `${minutes}:${pad2(seconds)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
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

function splitSendContentParts(content: string): string[] {
  return content
    .split(/\r?\n|\\r\\n|\\n/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function filterParentheticalSendContent(content: string): string {
  return content
    .split(/\r?\n|\\r\\n|\\n/g)
    .filter((line) => !containsDsmlMarkup(line))
    .join("\n")
    .replace(/[ \t]*\([^()\r\n]*\)[ \t]*/g, " ")
    .replace(/[ \t]*（[^（）\r\n]*）[ \t]*/g, " ")
    .split(/\r?\n|\\r\\n|\\n/g)
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .join("\n");
}

function containsDsmlMarkup(value: string): boolean {
  return /<\s*[｜|]{2}\s*DSML\s*[｜|]{2}/i.test(value);
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
    createdAt: output.meta.createdAt,
    createdAtUtc: output.meta.createdAtUtc
  };
}

function summarizeOutput(output: AgentOutput): string {
  const content = output.content;
  if (content.kind === "text") return sanitizeMessageText(content.text);
  if (content.kind === "markdown") return content.markdown;
  if (content.kind === "audio") return summarizeAudioText(content.transcript, content.assetId);
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

function extractSentMessageCreatedAtUtc(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { createdAtUtc?: unknown };
  return typeof record.createdAtUtc === "string" ? record.createdAtUtc : undefined;
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

function integerValue(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(numeric) ? numeric : undefined;
}

function missingVoiceSynthesizer(): VoiceSynthesizer {
  return Object.assign(async () => {
    throw new Error("Voice synthesizer is not configured");
  }, {});
}

async function removeGeneratedVoice(filePath: string): Promise<void> {
  try {
    await fsp.unlink(filePath);
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (code !== "ENOENT") throw error;
  }
}

async function copyVoiceMessageTrainingAsset(input: {
  outputDir: string;
  text: string;
  target: MessagingToolTarget;
  synthesized: VoiceSynthesisResult;
  status: "sent" | "failed";
  archivedAt: string;
}): Promise<string> {
  const outputDir = path.resolve(input.outputDir);
  await fsp.mkdir(outputDir, { recursive: true });
  const extension = path.extname(input.synthesized.filePath) || ".audio";
  const baseName = [
    safeTrainingPathPart(input.archivedAt.replace(/[:.]/g, "-")),
    safeTrainingPathPart(input.target.plugin),
    safeTrainingPathPart(input.target.sessionId),
    safeTrainingPathPart(path.basename(input.synthesized.assetId, path.extname(input.synthesized.assetId)))
  ].join("-");
  const audioPath = path.join(outputDir, `${baseName}${extension}`);
  await fsp.copyFile(input.synthesized.filePath, audioPath);
  await fsp.writeFile(`${audioPath}.json`, `${JSON.stringify({
    text: input.text,
    status: input.status,
    plugin: input.target.plugin,
    accountId: input.target.accountId,
    channelId: input.target.channelId,
    userId: input.target.userId,
    sessionId: input.target.sessionId,
    assetId: input.synthesized.assetId,
    sourceFilePath: input.synthesized.filePath,
    audioFilePath: audioPath,
    archivedAt: input.archivedAt
  }, null, 2)}\n`, "utf8");
  return audioPath;
}

function safeTrainingPathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96) || "unknown";
}
