import type { CurrentTimeProvider } from "../../../core/time/src/index.js";
import { createCurrentTimeProvider } from "../../../core/time/src/index.js";
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
    | "searchMessages"
    | "getToolCursor"
    | "setToolCursor"
    | "insertOutboundMessage"
    | "markOutboundMessageSent"
    | "markOutboundMessageFailed"
  >;
  outputRouter: Pick<OutputRouter, "send">;
  time?: CurrentTimeProvider;
  getDefaultTarget?(): MessagingToolTarget | undefined;
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

export function createMessagingTools(deps: MessagingToolsDeps): ToolPlugin {
  const time = deps.time ?? createCurrentTimeProvider("UTC");

  return {
    id: "messaging",
    listTools() {
      return [viewMessagesTool, sendMessageTool, searchMessagesTool];
    },
    async execute(call) {
      if (call.toolName === "view_messages") return viewMessages(call);
      if (call.toolName === "send_message") return sendMessage(call);
      if (call.toolName === "search_messages") return searchMessages(call);
      return { callId: call.id, ok: false, error: `Unknown messaging tool: ${call.toolName}` };
    }
  };

  async function viewMessages(call: ToolCall): Promise<ToolResult> {
    const target = resolveTarget(call);
    if (!target) return toolError(call, "No current messaging session is available");
    const scope = stringValue(call.input.scope ?? call.input.scpe) === "new" ? "new" : "today";
    const all = deps.store.listMessagesForConversation(target.sessionId, 500);
    let messages: StoredConversationMessage[];
    if (scope === "new") {
      const cursor = deps.store.getToolCursor(target.plugin, target.sessionId, "view_messages") ?? 0;
      messages = all.filter((message) => message.id > cursor);
      const latest = all[all.length - 1];
      if (latest) deps.store.setToolCursor(target.plugin, target.sessionId, "view_messages", latest.id);
    } else {
      const today = localDate(time.now().date, time.timeZone);
      messages = all.filter((message) => localDate(new Date(message.createdAt), time.timeZone) === today);
    }

    return {
      callId: call.id,
      ok: true,
      output: messages.length > 0 ? messages.map((message) => formatMessageLine(message, time.timeZone)).join("\n") : "nothing new"
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
      conversationId: target.sessionId,
      query: content,
      direction,
      limit
    });
    const conversation = deps.store.listMessagesForConversation(target.sessionId, 1000);
    const blocks = hits.map((hit) => {
      const hitIndex = conversation.findIndex((message) => message.id === hit.id);
      const context = hitIndex === -1 ? [hit] : contextSlice(conversation, hitIndex, contextCount);
      return {
        hitMessageId: hit.id,
        hitTime: formatLocalDateTime(new Date(hit.createdAt), time.timeZone),
        direction,
        messages: context.map((message) => formatMessageLine(message, time.timeZone))
      };
    });

    return {
      callId: call.id,
      ok: true,
      output: blocks.length > 0
        ? blocks.map((block, index) => [
          `#${index + 1} hit=${block.hitMessageId} time=${block.hitTime}`,
          ...block.messages
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
      if (index > 0) await delay(500);
      const output = buildOutput(target, type, part);
      const stored = deps.store.insertOutboundMessage(toStoredOutbound(output));
      try {
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
}

const viewMessagesTool: ToolDefinition = {
  name: "view_messages",
  description: "View messages in the current messaging conversation. Defaults to today's messages.",
  inputSchema: {
    type: "object",
    properties: {
      scope: { type: "string", enum: ["today", "new"], default: "today" },
      scpe: { type: "string", enum: ["today", "new"], description: "Deprecated alias for scope." }
    },
    additionalProperties: false
  }
};

const sendMessageTool: ToolDefinition = {
  name: "send_message",
  description: "Send a message to the current messaging conversation. Plain message mode splits newline-separated content into multiple messages.",
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

function formatMessageLine(message: StoredConversationMessage, timeZone: string): string {
  const speaker = message.direction === "outbound" || message.senderRole === "assistant" ? "Alice" : "user";
  const recalled = message.isRecalled ? "[已撤回]" : "";
  const reactions = summarizeReactions(message.reactionsJson);
  return `[${formatLocalDateTime(new Date(message.createdAt), timeZone)}] ${speaker}:${message.isRecalled ? "(message recalled)" : message.contentText}${reactions ? `[reaction: ${reactions}]` : ""}${recalled}`;
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

function localDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function formatLocalDateTime(date: Date, timeZone: string): string {
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
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toolError(call: ToolCall, error: string): ToolResult {
  return { callId: call.id, ok: false, error };
}
