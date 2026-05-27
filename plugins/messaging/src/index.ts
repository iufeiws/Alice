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
    | "getToolCursor"
    | "setToolCursor"
    | "insertOutboundMessage"
    | "markOutboundMessageSent"
    | "markOutboundMessageFailed"
  >;
  outputRouter: Pick<OutputRouter, "send">;
  time?: CurrentTimeProvider;
  sleep?: (ms: number) => Promise<void>;
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
};

export type MessagingToolPlugin = ToolPlugin & {
  noteLLMRequestStarted(): void;
};

const messageDelayMsPerCharacter = 120;
const minMessageDelayMs = 500;
const maxMessageDelayMs = 8_000;
const maxSendRetryAttempts = 3;

export function createMessagingTools(deps: MessagingToolsDeps): MessagingToolPlugin {
  const time = deps.time ?? createCurrentTimeProvider("UTC");
  const userName = () => deps.getUserName?.() || "user";
  const sleep = deps.sleep ?? delay;
  let lastMessageTimestampMs: number | undefined;
  let retryQueue = Promise.resolve();

  return {
    id: "messaging",
    noteLLMRequestStarted() {
      lastMessageTimestampMs = time.now().epochMs;
    },
    listTools() {
      return [checkFeishuTool, sendFeishuTool];
    },
    async execute(call) {
      if (call.toolName === "check_feishu" || call.toolName === "view_messages") return viewMessages(call);
      if (call.toolName === "send_feishu" || call.toolName === "send_message") return sendMessage(call);
      if (call.toolName === "search_messages") return searchMessages(call);
      return { callId: call.id, ok: false, error: `Unknown messaging tool: ${call.toolName}` };
    }
  };

  async function viewMessages(call: ToolCall): Promise<ToolResult> {
    const target = resolveTarget(call);
    if (!target) return toolError(call, "No current messaging session is available");
    const scope = stringValue(call.input.scope ?? call.input.scpe) === "new" ? "new" : "today";
    const all = deps.store.listMessages(500).filter((message) => message.plugin === target.plugin);
    let messages: StoredConversationMessage[];
    let sinceDate: Date;
    if (scope === "new") {
      const cursor = deps.store.getToolCursor(target.plugin, target.sessionId, "check_feishu") ?? 0;
      const cursorMessage = all.find((message) => message.id === cursor);
      sinceDate = cursorMessage ? parseMessageTime(cursorMessage.createdAt, time.timeZone) : new Date(0);
      messages = all.filter((message) => message.id > cursor);
      const latest = all[all.length - 1];
      if (latest) deps.store.setToolCursor(target.plugin, target.sessionId, "check_feishu", latest.id);
    } else {
      const after = todayMessagingAnchor(time.timeZone, time.now().date).getTime();
      sinceDate = new Date(after);
      messages = all.filter((message) => parseMessageTime(message.createdAt, time.timeZone).getTime() >= after);
    }

    const currentDate = time.now().date;
    const shellEvents = readShellSwitchContext(sinceDate);
    return {
      callId: call.id,
      ok: true,
      output: appendCurrentTime(
        messages.length > 0 || shellEvents.length > 0
          ? formatTimelineBlocks(messages, shellEvents, time.timeZone, userName(), currentDate)
          : "nothing new",
        time.timeZone,
        currentDate
      )
    };
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
    const parts = type === "message"
      ? content.split(/\r?\n/).map((part) => part.trim()).filter(Boolean)
      : [content];
    if (parts.length === 0) return toolError(call, "content is required");

    const results = [];
    for (const [index, part] of parts.entries()) {
      await waitForMessageSendSlot(part);
      const output = buildOutput(target, type, part);
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
        results.push({ ok: true, messageId: extractSentMessageId(sent), content: part });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
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
        enqueueSendRetry({ output, storedId: stored.id, content: part });
        results.push({ ok: false, error: reason, content: part });
      }
    }

    const failed = results.find((result) => !result.ok);
    return {
      callId: call.id,
      ok: !failed,
      output: formatSendResults(type, results),
      error: failed?.error
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
        const reason = error instanceof Error ? error.message : String(error);
        deps.store.markOutboundMessageFailed(input.storedId, time.now().iso, reason);
        deps.appendMessageLog?.({
          direction: "outbound",
          plugin: input.output.target.plugin,
          kind: input.output.content.kind,
          target: input.output.target.channelId ?? input.output.target.userId,
          sessionId: input.output.target.sessionId,
          status: "retry_failed",
          summary: summarizeOutput(input.output),
          error: reason
        });
      }
    }
  }

  function resolveTarget(call: ToolCall): MessagingToolTarget | undefined {
    if (call.requester?.plugin && call.session?.sessionId) {
      return {
        plugin: call.requester.plugin,
        accountId: call.requester.accountId,
        channelId: call.requester.channelId,
        userId: call.requester.userId,
        sessionId: call.session.sessionId
      };
    }
    return deps.getDefaultTarget?.();
  }

  function buildOutput(target: MessagingToolTarget, type: "message" | "markdown" | "image", content: string): AgentOutput {
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

const checkFeishuTool: ToolDefinition = {
  name: "check_feishu",
  description: "查看当前一对一飞书聊天记录。默认读取 today 消息：本地时间 6 点前从前一天 00:00 开始，6 点后从当天 00:00 开始；scope=new 只返回上次查看后新增的飞书消息。",
  inputSchema: {
    type: "object",
    properties: {
      scope: { type: "string", enum: ["today", "new"], default: "today" },
      scpe: { type: "string", enum: ["today", "new"], description: "Deprecated alias for scope." }
    },
    additionalProperties: false
  }
};

const sendFeishuTool: ToolDefinition = {
  name: "send_feishu",
  description: "发送飞书消息到当前一对一聊天。type 默认 message；message 模式会把 content 中的换行拆成多条飞书消息并间隔发送。",
  inputSchema: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["message", "markdown", "image"], default: "message" },
      content: { type: "string" }
    },
    required: ["content"],
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
  userName: string,
  now: Date
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
      currentLines = [`[${formatChatTime(entry.time, timeZone, now)}]`];
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
      currentLines = [`[${formatChatTime(messageTime, timeZone, now)}]`];
    }
    currentLines.push(formatMessageContentLine(message, userName));
  }

  if (currentLines.length > 0) blocks.push(currentLines.join("\n"));
  return blocks.join("\n");
}

function formatContextEntryLine(entry: ChatContextEntry, userName: string): string {
  if (entry.kind === "shell") {
    return `(壳切换-切换为${entry.personalityName}的${entry.relationshipName}爱丽丝)`;
  }
  return formatMessageContentLine(entry.message, userName);
}

function appendCurrentTime(output: string, timeZone: string, date: Date): string {
  return `<chat>\n${output}\n</chat>\nCurrent time is [${formatLocalDateTime(date, timeZone)}]`;
}

function formatMessageContentLine(message: StoredConversationMessage, userName: string): string {
  const speaker = message.direction === "outbound" || message.senderRole === "assistant" ? "Alice" : userName;
  const recalled = message.isRecalled ? "[已撤回]" : "";
  const reactions = summarizeReactions(message.reactionsJson);
  return `${speaker}:${message.isRecalled ? "(message recalled)" : message.contentText}${reactions ? `[reaction: ${reactions}]` : ""}${recalled}`;
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

function formatChatTime(date: Date, timeZone: string, nowDate: Date): string {
  const values = localDateTimeParts(date, timeZone);
  const now = localDateTimeParts(nowDate, timeZone);
  if (values.year === now.year && values.month === now.month && values.day === now.day) {
    return `${values.hour}:${values.minute}`;
  }
  const yesterday = shiftLocalDateParts(now, -1);
  if (values.year === yesterday.year && values.month === yesterday.month && values.day === yesterday.day) {
    return `yesterday ${values.hour}:${values.minute}`;
  }
  if (values.year === now.year) {
    return `${values.month}-${values.day} ${values.hour}:${values.minute}`;
  }
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
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

function normalizeSendType(value: unknown): "message" | "markdown" | "image" | undefined {
  const text = stringValue(value) || "message";
  if (text === "message" || text === "markdown" || text === "image") return text;
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
  if (content.kind === "image" || content.kind === "audio") return content.assetId;
  if (content.kind === "file") return content.filename || content.assetId;
  if (content.kind === "card") return content.card.title;
  return content.kind;
}

function extractSentMessageId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { messageId?: unknown };
  return typeof record.messageId === "string" ? record.messageId : undefined;
}

function formatSendResults(type: "message" | "markdown" | "image", results: Array<{ ok: boolean; messageId?: string; error?: string; content: string }>): string {
  return results.map((result, index) => {
    const status = result.ok ? "sent" : `failed: ${result.error ?? "unknown error"}`;
    return `#${index + 1} ${type} ${status}${result.messageId ? ` ${result.messageId}` : ""}: ${result.content}`;
  }).join("\n");
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
