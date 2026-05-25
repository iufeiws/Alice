import type { AgentEvent } from "../../../../packages/types/src/index.js";
import { createId } from "../../../../packages/types/src/index.js";
import { createCurrentTimeProvider, type CurrentTimeProvider } from "../../../../core/time/src/index.js";
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
  const parsed = parseFeishuTextContent(message.content);
  const mentionsBot = Boolean(message.mentions?.length);
  const mentionKeys = message.mentions?.map((mention) => mention.key).filter(isString) ?? [];
  const text = stripMentionTokens(parsed.text, mentionKeys);
  const scope = message.chat_type === "p2p" ? "dm" : "group";
  const sessionId = await bindings.resolveSession({
    chatId: message.chat_id,
    chatType: message.chat_type,
    userId,
    threadId: message.thread_id
  });

  return {
    id: raw.header?.event_id ?? createId("evt"),
    source: {
      plugin: "feishu",
      accountId,
      channelId: message.chat_id,
      userId,
      rawMessageId: message.message_id
    },
    session: {
      scope,
      sessionId,
      threadId: message.thread_id
    },
    type: "message.text",
    payload: {
      kind: "text",
      text
    },
    meta: {
      receivedAt: raw.header?.create_time ? time.addMs(0, new Date(Number(raw.header.create_time))).iso : time.now().iso,
      mentionsBot,
      replyTo: message.message_id,
      raw
    }
  };
}

function parseFeishuTextContent(content: string): { text: string } {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return { text: typeof parsed.text === "string" ? parsed.text : content };
  } catch {
    return { text: content };
  }
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
