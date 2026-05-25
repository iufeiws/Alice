import { createCurrentTimeProvider, type CurrentTimeProvider } from "../../../../core/time/src/index.js";
import type { FeishuMessageLifecycleEvent } from "../types.js";

export function reactionEventToLifecycleEvent(
  raw: unknown,
  kind: "reaction.created" | "reaction.deleted",
  time: CurrentTimeProvider = createCurrentTimeProvider("UTC")
): FeishuMessageLifecycleEvent {
  const data = raw as any;
  const event = data?.event ?? data;
  const messageId = firstString(
    event?.message_id,
    event?.message?.message_id,
    event?.message?.message_id,
    event?.reaction?.message_id
  );
  const emoji = firstString(
    event?.reaction?.emoji_type,
    event?.reaction?.emoji,
    event?.reaction?.reaction_type,
    event?.emoji_type,
    event?.emoji
  ) ?? "unknown";

  return {
    kind,
    externalEventId: firstString(data?.event_id, data?.header?.event_id, event?.event_id),
    externalMessageId: messageId ?? "",
    conversationId: firstString(event?.chat_id, event?.message?.chat_id),
    actorId: firstString(
      event?.operator_id?.open_id,
      event?.operator_id?.user_id,
      event?.user_id?.open_id,
      event?.user_id?.user_id,
      event?.sender?.sender_id?.open_id,
      event?.sender?.sender_id?.user_id
    ),
    emoji,
    occurredAt: eventTime(data, event, time),
    raw
  };
}

export function readEventToLifecycleEvent(raw: unknown, time: CurrentTimeProvider = createCurrentTimeProvider("UTC")): FeishuMessageLifecycleEvent {
  const data = raw as any;
  const event = data?.event ?? data;
  const messageId = firstString(event?.message_id, event?.message?.message_id);
  return {
    kind: "message.read",
    externalEventId: firstString(data?.event_id, data?.header?.event_id, event?.event_id),
    externalMessageId: messageId ?? "",
    conversationId: firstString(event?.chat_id, event?.message?.chat_id),
    actorId: firstString(
      event?.reader?.reader_id?.open_id,
      event?.reader?.reader_id?.user_id,
      event?.user_id?.open_id,
      event?.user_id?.user_id
    ),
    occurredAt: eventTime(data, event, time),
    raw
  };
}

export function recalledEventToLifecycleEvent(raw: unknown, time: CurrentTimeProvider = createCurrentTimeProvider("UTC")): FeishuMessageLifecycleEvent {
  const data = raw as any;
  const event = data?.event ?? data;
  const messageId = firstString(event?.message_id, event?.message?.message_id);
  return {
    kind: "message.recalled",
    externalEventId: firstString(data?.event_id, data?.header?.event_id, event?.event_id),
    externalMessageId: messageId ?? "",
    conversationId: firstString(event?.chat_id, event?.message?.chat_id),
    actorId: firstString(
      event?.operator_id?.open_id,
      event?.operator_id?.user_id,
      event?.sender?.sender_id?.open_id,
      event?.sender?.sender_id?.user_id
    ),
    occurredAt: eventTime(data, event, time),
    raw
  };
}

function eventTime(data: any, event: any, time: CurrentTimeProvider): string {
  const raw = firstString(data?.create_time, data?.header?.create_time, event?.create_time, event?.event_time);
  if (raw && /^\d+$/.test(raw)) return time.addMs(0, new Date(Number(raw))).iso;
  if (raw) return raw;
  return time.now().iso;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}
