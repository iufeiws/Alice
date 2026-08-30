import type { VoiceSynthesisResult } from "../../../../channels/tts/src/index.js";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AgentOutput } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { ToolCall, ToolResult } from "../../../../contexts/tool-execution/src/index.js";
import type { StoredConversationMessage } from "../../../../contexts/conversation-hub/src/ports/conversation-store.js";
import { resolveSandboxHostPath } from "../../../../contexts/bash-sandbox/src/index.js";
import { createCurrentTimeProvider, todayMessagingAnchor } from "../../../../platform/time/src/index.js";
import { createId } from "../../../../shared/uuid/src/index.js";
import { chatTool, messagingToolText } from "../profile.js";
import { normalizeMessagingPluginConfig } from "./config.js";
import {
  buildOutput,
  delay,
  escapeXml,
  normalizeSendContent,
  isImageFile,
  messageDelayForContent,
  missingVoiceSynthesizer,
  normalizeSendError,
  normalizeSenderName,
  normalizeSendType,
  normalizeTarget,
  renderSendPart,
  shouldSplitSendContent,
  splitSendContentParts,
  stringValue,
  summarizeOutput,
  toStoredOutbound
} from "./send-utils.js";
import { extractSentMessageCreatedAtUtc, extractSentMessageId } from "./sent-message-utils.js";
import {
  appendCurrentTime,
  formatCheckChatMessages,
  formatTimelineBlocks,
  isUnreadUserMessage,
  optionalStringValue,
  parseMessageTime
} from "./timeline-format.js";
import type {
  MessagingPluginConfig,
  MessagingToolPlugin,
  MessagingToolsDeps,
  MessagingToolTarget,
  SendPartResult,
  SendType,
  ShellSwitchContextEntry
} from "./types.js";
import { copyVoiceMessageTrainingAsset, removeGeneratedVoice } from "./voice-training-archive.js";

const maxSendRetryAttempts = 3;
const checkChatMessageLimit = 500;
const recentCheckChatMessageCount = 50;
const recentUserReplyWindow = 10;
const todayContextMessageCount = 10;
const maxRangeEndTime = "9999-12-31T23:59:59.999Z";
const userSpeakerPlaceholder = "${{user}}";

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
      return [chatTool];
    },
    async execute(call) {
      if (call.toolName === "Chat" && call.input.action === "poll") return viewMessages(call);
      if (call.toolName === "Chat" && call.input.action === "send") return sendMessage(call);
      if (call.toolName === "Chat") return toolError(call, messagingToolText.unsupportedAction);
      return { callId: call.id, ok: false, error: messagingToolText.unknownTool(call.toolName) };
    }
  };

  async function viewMessages(call: ToolCall): Promise<ToolResult> {
    const target = resolveTarget(call);
    if (!target) return toolError(call, messagingToolText.noCurrentSession);
    const readonly = call.input.__preview === true;
    const result = viewMessagesForScope(call.id, resolveViewScope(call.input.scope ?? call.input.__scope), {
      readonly,
      from: optionalStringValue(call.input.from),
      to: optionalStringValue(call.input.to)
    });
    if (!readonly && result.ok) deps.onMessagesPolled?.(target.sessionId);
    return result;
  }

  function viewMessagesForScope(
    callId: string,
    scope: "recent" | "today" | "todayold" | "new" | "range",
    options: { readonly?: boolean; from?: string; to?: string } = {}
  ): ToolResult {
    let messages: StoredConversationMessage[];
    let sinceDate: Date;
    if (scope === "recent") {
      const all = deps.store.listMessages(checkChatMessageLimit);
      messages = all.slice(-recentCheckChatMessageCount);
      sinceDate = messages.length > 0 ? parseMessageTime(messages[0].createdAt, time.timeZone) : new Date(0);
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
      sinceDate = sleepCocoonDate
        ? contextStartBefore(sleepCocoonDate)
        : todayMessagingAnchor(time.timeZone, time.now().date);
      const latestShortMemoryCreatedAtUtc = deps.getLatestShortMemoryCreatedAtUtc?.();
      if (latestShortMemoryCreatedAtUtc) {
        const latestShortMemoryDate = parseMessageTime(latestShortMemoryCreatedAtUtc, time.timeZone);
        const shortMemoryContextStart = contextStartBefore(latestShortMemoryDate);
        if (shortMemoryContextStart.getTime() > sinceDate.getTime()) sinceDate = shortMemoryContextStart;
      }
      messages = deps.store.listMessagesByCreatedAtRange(sinceDate.toISOString(), maxRangeEndTime);
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
      output: appendCurrentTime(body, time.now().iso, prefix)
    };
  }

  function contextStartBefore(boundary: Date): Date {
    const contextMessages = deps.store
      .listMessagesByCreatedAtRange(undefined, boundary.toISOString())
      .slice(-todayContextMessageCount);
    return contextMessages.length > 0
      ? parseMessageTime(contextMessages[0].createdAt, time.timeZone)
      : boundary;
  }

  function resolveViewScope(scopeHint?: unknown): "recent" | "today" | "todayold" | "new" | "range" {
    if (scopeHint === "recent") return "recent";
    if (scopeHint === "today") return "today";
    if (scopeHint === "todayold") return "todayold";
    if (scopeHint === "new") return "new";
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

  async function sendMessage(call: ToolCall): Promise<ToolResult> {
    const target = resolveTarget(call);
    if (!target) return toolError(call, messagingToolText.noCurrentSession);
    const type = normalizeSendType(call.input.type);
    if (!type) return toolError(call, messagingToolText.unsupportedMessageType);
    const rawContent = stringValue(call.input.content);
    const senderName = normalizeSenderName(call.input.alice ?? call.input.senderName ?? "shell");
    const content = type === "message" || type === "voice"
      ? normalizeSendContent(rawContent)
      : rawContent;
    if (!content.trim()) return toolError(call, messagingToolText.contentRequired);
    const config = resolveMessagingConfig();
    const renderedType = renderSendPart(target, type, content, senderName, config).type;
    const parts = shouldSplitSendContent(config, type, renderedType)
      ? splitSendContentParts(content)
      : [type === "message" || type === "voice" || type === "file" ? content.trim() : content];
    if (parts.length === 0) return toolError(call, messagingToolText.contentRequired);
    if (config.limitConsecutiveSends && !recentMessagesAllowSend(target)) return toolError(call, messagingToolText.waitForUserReplyBeforeSending);

    const results = [];
    for (const part of parts) {
      if (type === "voice") {
        results.push(...await sendVoicePart(target, part, senderName));
      } else if (type === "file") {
        results.push(...await sendSandboxFilePart(target, part, senderName));
      } else {
        results.push(await sendOutputPart(target, type, part, { retry: true, senderName }, config));
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
      .some((message) => (message.direction === "inbound" || message.direction === "both") && message.senderRole === "user");
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
      synthesized = await voiceSynthesizer({ text, time, alice: senderAlice(senderName) });
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

  function senderAlice(senderName: string | undefined): "core" | "shell" | undefined {
    return senderName === "core" || senderName === "shell" ? senderName : undefined;
  }

  async function sendSandboxFilePart(target: MessagingToolTarget, sandboxPath: string, senderName?: string): Promise<SendPartResult[]> {
    const config = deps.bashSandbox;
    if (!config) return [{ ok: false, error: messagingToolText.sandboxSendDisabled, content: sandboxPath }];
    const hostPath = resolveSandboxHostPath(config, sandboxPath);
    if (!hostPath) return [{ ok: false, error: messagingToolText.sandboxPathOutside(sandboxPath), content: sandboxPath }];
    let stat;
    try {
      stat = await fsp.stat(hostPath);
    } catch {
      return [{ ok: false, error: messagingToolText.sandboxFileNotFound(sandboxPath), content: sandboxPath }];
    }
    if (!stat.isFile()) return [{ ok: false, error: messagingToolText.sandboxNotAFile(sandboxPath), content: sandboxPath }];
    const asImage = await isImageFile(hostPath);
    const assetId = await stageSandboxFileForSend(hostPath);
    if (!assetId) return [{ ok: false, error: messagingToolText.sandboxFileStageFailed(sandboxPath), content: sandboxPath }];
    return [await sendOutputPart(target, asImage ? "image" : "file", assetId, {
      filename: path.basename(hostPath),
      retry: true,
      senderName
    })];
  }

  async function stageSandboxFileForSend(hostPath: string): Promise<string | undefined> {
    try {
      const assetRoot = path.resolve(deps.sandboxSendAssetRoot ?? "assets");
      const outputDir = path.resolve(deps.sandboxSendOutputDir ?? "assets/plugin/send-file");
      const relativeDir = path.relative(assetRoot, outputDir);
      if (relativeDir.startsWith("..") || path.isAbsolute(relativeDir)) return undefined;
      await fsp.mkdir(outputDir, { recursive: true });
      const extension = path.extname(hostPath) || "";
      const baseName = safeSendFileName(path.basename(hostPath, extension));
      const fileName = `${baseName}_${time.now().epochMs}_${Math.random().toString(36).slice(2, 8)}${extension}`;
      await fsp.copyFile(hostPath, path.join(outputDir, fileName));
      return path.join(relativeDir, fileName);
    } catch {
      return undefined;
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
    options: { transcript?: string; retry: boolean; skipWait?: boolean; senderName?: string; filename?: string },
    config?: MessagingPluginConfig
  ): Promise<SendPartResult> {
    if (!options.skipWait) await waitForMessageSendSlot(options.transcript ?? content);
    const rendered = renderSendPart(target, type, content, options.senderName, config);
    const output = buildOutput(target, rendered.type, rendered.content, time.now(), options.transcript, options.senderName, options.filename);
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
    const output = buildOutput(target, "markdown", text, time.now(), undefined, senderName);
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

function toolError(call: ToolCall, error: string): ToolResult {
  return { callId: call.id, ok: false, error };
}

function safeSendFileName(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96);
  return cleaned || "file";
}
