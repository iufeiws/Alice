import type { AgentEvent } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import { createId } from "../../../../shared/uuid/src/index.js";
import { createCurrentTimeProvider } from "../../../../platform/time/src/index.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { FeishuBindingStore } from "../bindings.js";
import type { FeishuTextMessageEvent } from "../types.js";

export async function textMessageEventToAgentEvent(
  raw: FeishuTextMessageEvent,
  bindings: FeishuBindingStore,
  accountId = "main",
  time: CurrentTimeProvider = createCurrentTimeProvider("UTC")
): Promise<AgentEvent> {
  const message = raw.event.message;
  const sender = raw.event.sender.sender_id;
  const userId = sender.open_id ?? sender.user_id;
  const messageType = message.message_type ?? message.msg_type;
  const parsed = parseFeishuContent(message.content);
  const mentionsBot = Boolean(message.mentions?.length);
  const mentionKeys = message.mentions?.map((mention) => mention.key).filter(isString) ?? [];
  const text = stripMentionTokens(parsed.text ?? message.content, mentionKeys);
  const scope = message.chat_type === "p2p" ? "dm" : "group";
  const sessionId = await bindings.resolveSession({
    chatId: message.chat_id,
    chatType: message.chat_type,
    userId,
    threadId: message.thread_id
  });

  const receivedAtUtc = raw.header?.create_time ? new Date(Number(raw.header.create_time)).toISOString() : time.now().date.toISOString();
  const payload = messagePayload(messageType, parsed, text);
  return {
    id: raw.header?.event_id ?? createId("evt"),
    source: {
      plugin: "feishu",
      accountId,
      channelId: message.chat_id,
      userId,
      rawMessageId: message.message_id
    },
    externalSession: {
      scope,
      sessionId,
      threadId: message.thread_id
    },
    type: `message.${payload.kind}` as AgentEvent["type"],
    payload,
    meta: {
      receivedAt: time.addMs(0, new Date(receivedAtUtc)).iso,
      receivedAtUtc,
      mentionsBot,
      replyTo: message.message_id,
      raw
    }
  };
}

function parseFeishuContent(content: string): { text?: string; fileKey?: string; imageKey?: string; filename?: string; mime?: string } {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return {
      text: typeof parsed.text === "string" ? parsed.text : undefined,
      fileKey: typeof parsed.file_key === "string" ? parsed.file_key : typeof parsed.fileKey === "string" ? parsed.fileKey : undefined,
      imageKey: typeof parsed.image_key === "string" ? parsed.image_key : typeof parsed.imageKey === "string" ? parsed.imageKey : undefined,
      filename: firstString(parsed, "file_name", "fileName", "name"),
      mime: firstString(parsed, "mime_type", "mimeType")
    };
  } catch {
    return { text: content };
  }
}

function messagePayload(
  messageType: string | undefined,
  parsed: { text?: string; fileKey?: string; imageKey?: string; filename?: string; mime?: string },
  text: string
): AgentEvent["payload"] {
  if (messageType === "image" && parsed.imageKey) {
    return {
      kind: "image",
      resource: {
        id: parsed.imageKey,
        filename: parsed.filename,
        mime: parsed.mime
      }
    };
  }
  if (messageType === "file" && parsed.fileKey) {
    return {
      kind: "file",
      resource: {
        id: parsed.fileKey,
        filename: parsed.filename,
        mime: parsed.mime
      },
      filename: parsed.filename,
      mime: parsed.mime
    };
  }
  return { kind: "text", text };
}

function firstString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function stripMentionTokens(text: string, mentionKeys: string[]): string {
  let normalized = text;
  for (const key of mentionKeys) {
    normalized = normalized.replaceAll(key, "");
  }
  return normalized.trim();
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
