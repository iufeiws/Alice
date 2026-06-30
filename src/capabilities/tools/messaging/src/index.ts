import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import { createCurrentTimeProvider } from "../../../../platform/time/src/index.js";
import { todayMessagingAnchor } from "../../../../platform/time/src/index.js";
import { parseZonedIso } from "../../../../platform/time/src/index.js";
import type { OutputRouter } from "../../../../platform/output-router/src/index.js";
import type { AgentOutput, ToolCall, ToolPlugin, ToolResult } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { ToolOutputTargetResolver } from "../../../../contexts/capabilities/src/tool-output-target.js";
import { createId } from "../../../../shared/uuid/src/index.js";
import { sanitizeMessageText, summarizeAudioText } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { VoiceSynthesisResult, VoiceSynthesizer } from "../../../../channels/tts/src/index.js";
import type {
  AliceStore,
  InsertOutboundMessageInput,
  StoredConversationMessage
} from "../../../../contexts/conversation-hub/src/ports/conversation-store.js";
import { checkChatTool, messagingSystemPromptMessages, messagingToolText, sendChatTool } from "../profile.js";

const fsp = await import("node:fs/promises");
const fs = await import("node:fs");
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
    | "listMessagesByCreatedAtRange"
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
  config?: MessagingPluginConfig | (() => MessagingPluginConfig);
  getUserName?: () => string;
  getDefaultTarget?(): MessagingToolTarget | undefined;
  resolveOutputTarget?: ToolOutputTargetResolver;
  getShellSwitchLogs?(): Array<{
    time: string;
    personalityName: string;
    relationshipName: string;
  }>;
  getSleepCocoonEnteredAt?(): string | undefined;
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

export type MessagingPluginConfig = {
  splitMultilineSendChat: boolean;
  limitConsecutiveSends: boolean;
  feishuTypingEmojiEnabled: boolean;
};

export const defaultMessagingPluginConfigPath = "config/plugin/messaging/config.json";

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
const recentUserReplyWindow = 10;
const todaySleepContextMessageCount = 10;
const maxRangeEndTime = "9999-12-31T23:59:59.999Z";
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
    : messagingToolText.nothingNew;
}

export function createMessagingTools(deps: MessagingToolsDeps): MessagingToolPlugin {
  const time = deps.time ?? createCurrentTimeProvider("UTC");
  const userName = () => deps.getUserName?.() || "user";
  const sleep = deps.sleep ?? delay;
  const voiceSynthesizer = deps.voiceSynthesizer ?? missingVoiceSynthesizer();
  const shouldPrepareVoiceSynthesizer = Boolean(deps.voiceSynthesizer);
  let lastMessageTimestampMs: number | undefined;
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
      return [checkChatTool, sendChatTool];
    },
    async execute(call) {
      if (call.toolName === "check_chat" || call.toolName === "check_feishu" || call.toolName === "check_wechat" || call.toolName === "view_messages") return viewMessages(call);
      if (call.toolName === "send_chat" || call.toolName === "send_feishu" || call.toolName === "send_wechat" || call.toolName === "send_message") return sendMessage(call);
      if (call.toolName === "search_messages") return searchMessages(call);
      return { callId: call.id, ok: false, error: messagingToolText.unknownTool(call.toolName) };
    }
  };

  async function viewMessages(call: ToolCall): Promise<ToolResult> {
    const target = resolveTarget(call);
    if (!target) return toolError(call, messagingToolText.noCurrentSession);
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
    const cursorMessageId = latestMessageCursorId();
    let messages: StoredConversationMessage[];
    let sinceDate: Date;
    if (scope === "recent") {
      const all = deps.store.listMessages(checkChatMessageLimit);
      messages = all.slice(-recentCheckChatMessageCount);
      sinceDate = messages.length > 0 ? parseMessageTime(messages[0].createdAt, time.timeZone) : new Date(0);
    } else if (scope === "from_prefix") {
      const all = deps.store.listMessages(checkChatMessageLimit);
      const afterId = options.fromPrefixAfterMessageId ?? 0;
      messages = all.filter((message) => message.id > afterId);
      sinceDate = messages.length > 0 ? parseMessageTime(messages[0].createdAt, time.timeZone) : time.now().date;
    } else if (scope === "range") {
      messages = deps.store.listMessagesByCreatedAtRange(options.from, options.to ?? maxRangeEndTime);
      sinceDate = options.from
        ? parseMessageTime(options.from, time.timeZone)
        : messages.length > 0
          ? parseMessageTime(messages[0].createdAt, time.timeZone)
          : time.now().date;
    } else if (scope === "new") {
      const all = deps.store.listMessages(checkChatMessageLimit);
      const firstUnread = all.find((message) => !message.isRead);
      sinceDate = firstUnread ? parseMessageTime(firstUnread.createdAt, time.timeZone) : new Date(0);
      messages = firstUnread ? all.filter((message) => message.id >= firstUnread.id) : [];
    } else if (scope === "today") {
      const sleepCocoonEnteredAt = deps.getSleepCocoonEnteredAt?.();
      const sleepCocoonDate = sleepCocoonEnteredAt ? parseMessageTime(sleepCocoonEnteredAt, time.timeZone) : undefined;
      if (sleepCocoonDate) {
        const sleepCocoonRangeStart = sleepCocoonDate.toISOString();
        const beforeSleep = deps.store
          .listMessagesByCreatedAtRange(undefined, sleepCocoonRangeStart)
          .slice(-todaySleepContextMessageCount);
        const afterSleep = deps.store.listMessagesByCreatedAtRange(sleepCocoonRangeStart, maxRangeEndTime);
        messages = [...beforeSleep, ...afterSleep];
        sinceDate = messages.length > 0 ? parseMessageTime(messages[0].createdAt, time.timeZone) : sleepCocoonDate;
      } else {
        const after = todayMessagingAnchor(time.timeZone, time.now().date).getTime();
        sinceDate = new Date(after);
        messages = deps.store.listMessagesByCreatedAtRange(sinceDate.toISOString(), maxRangeEndTime);
      }
    } else {
      const after = todayMessagingAnchor(time.timeZone, time.now().date).getTime();
      sinceDate = new Date(after);
      messages = deps.store.listMessagesByCreatedAtRange(sinceDate.toISOString(), maxRangeEndTime);
    }

    const shellEvents = scope === "new" && messages.length === 0 ? [] : readShellSwitchContext(sinceDate);
    const prefix = scope === "new" && messages.some(isUnreadUserMessage) ? messagingToolText.haveNewMessage : undefined;
    if (!options.readonly) markViewedMessages(messages);
    const body = formatCheckChatMessages(messages, { shellEvents, timeZone: time.timeZone, userName: userSpeakerPlaceholder });
    return {
      callId,
      ok: true,
      messageCursorId: cursorMessageId,
      output: appendCurrentTime(body, time.now().iso, prefix)
    };
  }

  function latestMessageCursorId(): number {
    return deps.store.listMessages(1).reduce((max, message) => Math.max(max, message.id), 0);
  }

  function resolveViewScope(scopeHint?: unknown): "recent" | "today" | "todayold" | "new" | "from_prefix" | "range" {
    if (scopeHint === "recent") return "recent";
    if (scopeHint === "today") return "today";
    if (scopeHint === "todayold") return "todayold";
    if (scopeHint === "new") return "new";
    if (scopeHint === "from_prefix") return "from_prefix";
    if (scopeHint === "range") return "range";
    return "new";
  }

  function markViewedMessages(messages: StoredConversationMessage[]): void {
    const ids = messages
      .filter((message) => !message.isRead)
      .map((message) => message.id);
    if (ids.length === 0) return;
    deps.store.markMessagesReadAndCoreProcessed(ids, time.now().iso, createId("check_read"));
  }

  async function searchMessages(call: ToolCall): Promise<ToolResult> {
    const target = resolveTarget(call);
    if (!target) return toolError(call, messagingToolText.noCurrentSession);
    const content = stringValue(call.input.content).trim();
    if (!content) return toolError(call, messagingToolText.contentRequired);
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
        : messagingToolText.nothingFound
    };
  }

  async function sendMessage(call: ToolCall): Promise<ToolResult> {
    const target = resolveTarget(call);
    if (!target) return toolError(call, messagingToolText.noCurrentSession);
    const type = normalizeSendType(call.input.type);
    if (!type) return toolError(call, messagingToolText.unsupportedMessageType);
    const rawContent = stringValue(call.input.content);
    const senderName = normalizeSenderName(call.input.alice ?? call.input.senderName);
    const content = type === "message" || type === "voice"
      ? filterParentheticalSendContent(rawContent)
      : rawContent;
    if (!content.trim()) return toolError(call, messagingToolText.contentRequired);
    const config = resolveMessagingConfig();
    const renderedType = renderSendPart(target, type, "", senderName).type;
    const parts = shouldSplitSendContent(config, type, renderedType)
      ? splitSendContentParts(content)
      : [type === "message" || type === "voice" ? content.trim() : content];
    if (parts.length === 0) return toolError(call, messagingToolText.contentRequired);
    if (config.limitConsecutiveSends && !recentMessagesAllowSend(target)) return toolError(call, messagingToolText.waitForUserReplyBeforeSending);

    const results = [];
    for (const part of parts) {
      if (type === "voice") {
        results.push(...await sendVoicePart(target, part, senderName));
      } else {
        results.push(await sendOutputPart(target, type, part, { retry: true, senderName }));
      }
    }

    const failed = results.find((result) => !result.ok);
    const view = viewSentMessageResults(call.id, target, results);
    return failed ? { ...view, ok: false, error: failed.error } : view;
  }

  function resolveMessagingConfig(): MessagingPluginConfig {
    return typeof deps.config === "function"
      ? deps.config()
      : deps.config ?? normalizeMessagingPluginConfig({});
  }

  function recentMessagesAllowSend(target: MessagingToolTarget): boolean {
    return deps.store.listMessagesForConversation(target.sessionId, recentUserReplyWindow)
      .some((message) => message.direction === "inbound" && message.senderRole === "user");
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
      .map((result) => messagingToolText.fallbackSentLine(result.content, result.ok));
    const output = [
      messages.length > 0 ? formatTimelineBlocks(messages, [], time.timeZone, userName()) : "",
      ...fallback
    ].filter(Boolean).join("\n");
    const prefix = results
      .filter((result) => !result.ok)
      .map((result) => messagingToolText.sendChatFailed(escapeXml(result.error ?? "unknown error")))
      .join("\n") || undefined;
    return {
      callId,
      ok: true,
      output: appendCurrentTime(output || messagingToolText.nothingNew, time.now().iso, prefix)
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

  async function sendVoicePart(target: MessagingToolTarget, text: string, senderName?: string): Promise<SendPartResult[]> {
    await waitForMessageSendSlot(text);
    if (target.plugin === "wechat" && deps.wechatVoiceFallbackToText !== false) {
      deps.appendLog?.("info", `wechat voice fallback to text: chars=${Array.from(text).length}`);
      return [await sendOutputPart(target, "message", text, { retry: true, skipWait: true, senderName })];
    }
    let synthesized: VoiceSynthesisResult | undefined;
    try {
      deps.appendLog?.("info", `voice tts start: chars=${Array.from(text).length}`);
      synthesized = await voiceSynthesizer({ text, time });
      const audioResult = await sendOutputPart(target, "voice", synthesized.assetId, { transcript: text, retry: false, skipWait: true, senderName });
      await archiveVoiceMessageTtsOutput(target, text, synthesized, audioResult.ok ? "sent" : "failed");
      if (target.plugin !== "feishu" || !audioResult.ok) return [audioResult];
      await sendFeishuVoiceTranscript(target, text, senderName);
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
    options: { transcript?: string; retry: boolean; skipWait?: boolean; senderName?: string }
  ): Promise<SendPartResult> {
    if (!options.skipWait) await waitForMessageSendSlot(options.transcript ?? content);
    const rendered = renderSendPart(target, type, content, options.senderName);
    const output = buildOutput(target, rendered.type, rendered.content, options.transcript, options.senderName);
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

  async function sendFeishuVoiceTranscript(target: MessagingToolTarget, text: string, senderName?: string): Promise<void> {
    const output = buildOutput(target, "markdown", text, undefined, senderName);
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
    if (call.requester?.plugin && call.externalSession?.sessionId) {
      return normalizeTarget({
        plugin: call.requester.plugin,
        accountId: call.requester.accountId,
        channelId: call.requester.channelId,
        userId: call.requester.userId,
        sessionId: call.externalSession.sessionId
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

  function renderSendPart(target: MessagingToolTarget, type: SendType, content: string, senderName?: string): { type: SendType; content: string } {
    if (target.plugin === "feishu" && type === "message" && senderName === "core") {
      return { type: "markdown", content };
    }
    return { type, content };
  }

  function buildOutput(target: MessagingToolTarget, type: SendType, content: string, transcript?: string, senderName?: string): AgentOutput {
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
        senderName,
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

  function shouldSplitSendContent(config: MessagingPluginConfig, type: SendType, renderedType: SendType): boolean {
    return config.splitMultilineSendChat && renderedType !== "markdown" && type === "message";
  }
}

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
    return messagingToolText.shellSwitch(entry.personalityName, entry.relationshipName);
  }
  return formatMessageContentLine(entry.message, userName);
}

function appendCurrentTime(output: string, currentTime: string, prefix?: string): string {
  return messagingToolText.appendCurrentTime(output, currentTime, prefix);
}

function isUnreadUserMessage(message: StoredConversationMessage): boolean {
  return !message.isRead && message.direction === "inbound" && message.senderRole === "user";
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
    "'": "&apos;"
  }[char]!));
}

function formatMessageContentLine(message: StoredConversationMessage, userName: string): string {
  const isSystem = isSystemPromptMessage(message);
  const speaker = message.direction === "outbound" || message.senderRole === "assistant"
      ? formatAssistantSpeaker(message.senderName)
      : userName;
  const recalled = message.isRecalled ? messagingToolText.recalledTag : "";
  const sendStatus = !isSystem && message.direction === "outbound" && message.status === "send_failed"
    ? messagingToolText.sendFailedTag
    : !isSystem && message.direction === "outbound" && message.status === "sending"
      ? messagingToolText.sendingTag
      : "";
  const reactions = summarizeReactions(message.reactionsJson);
  const content = `${message.isRecalled ? messagingToolText.recalledMessage : formatMessageContent(message)}${sendStatus}${reactions ? `[reaction: ${reactions}]` : ""}${recalled}`;
  if (isSystem) return content;
  if (isMediaActionMessage(message)) return `${speaker}${content}`;
  return content.includes("\n") ? `${speaker}:\n${content}` : `${speaker}:${content}`;
}

function formatAssistantSpeaker(value: string | undefined): string {
  return value === "core" || value === "shell" ? `Alice(${value})` : "Alice";
}

function formatMessageContent(message: StoredConversationMessage): string {
  const content = parseContentJson(message.contentJson);
  if (isVoiceCallTranscriptMessage(message)) return message.contentText;
  if (message.contentType === "image" || content?.kind === "image") return messagingToolText.imageMessage;
  if (message.contentType === "audio" || content?.kind === "audio") {
    const transcript = optionalStringValue(content?.transcript) || message.contentText;
    return summarizeAudioText(transcript, message.contentText);
  }
  if (message.contentType === "file" || content?.kind === "file") {
    const filePath = optionalStringValue(content?.filename) || optionalStringValue(content?.assetId) || message.contentText;
    return messagingToolText.fileMessage(filePath);
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
    if (text === "开始") activeCall.lines.push(messagingToolText.voiceCallStarted);
    else if (text === "结束") activeCall.lines.push(messagingToolText.voiceCallEnded);
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
  return messagingSystemPromptMessages.includes(message.contentText);
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
    .filter(Boolean)
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
    senderName: output.meta.senderName,
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

function normalizeSenderName(value: unknown): string | undefined {
  return value === "core" || value === "shell" ? value : undefined;
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

export function readMessagingPluginConfig(configPath = defaultMessagingPluginConfigPath): MessagingPluginConfig {
  const resolved = path.resolve(configPath);
  const parsed = parseJsonObject(fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : "{}");
  return normalizeMessagingPluginConfig(parsed);
}

export function normalizeMessagingPluginConfig(parsed: Record<string, unknown>): MessagingPluginConfig {
  return {
    splitMultilineSendChat: booleanValue(parsed.splitMultilineSendChat, true, "splitMultilineSendChat"),
    limitConsecutiveSends: booleanValue(parsed.limitConsecutiveSends, true, "limitConsecutiveSends"),
    feishuTypingEmojiEnabled: booleanValue(parsed.feishuTypingEmojiEnabled, true, "feishuTypingEmojiEnabled")
  };
}

function parseJsonObject(content: string): Record<string, unknown> {
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid messaging plugin config JSON");
  return parsed as Record<string, unknown>;
}

function booleanValue(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  throw new Error(`invalid ${field}: ${String(value)}`);
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
