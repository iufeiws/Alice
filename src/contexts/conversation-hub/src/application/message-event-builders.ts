import type { AgentEvent } from "../../../agent-loop/src/contracts/agent-contracts.js";
import { createId } from "../../../../shared/uuid/src/index.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { StoredConversationMessage } from "../../../../contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import type { MessageRuntimeDeps } from "./message-runtime-contracts.js";


export function buildAgentEventFromMessageLog(input: {
  sessionId: string;
  pending: StoredConversationMessage[];
  latestEvent: AgentEvent | undefined;
  allSessionLogs: StoredConversationMessage[];
}): AgentEvent {
  const { sessionId, pending, latestEvent, allSessionLogs } = input;
  const latestLog = pending[pending.length - 1];
  const text = "A chat message event was received. Use messaging tools to inspect conversation history before replying.";

  if (latestEvent) {
    return {
      ...latestEvent,
      id: latestEvent.id,
      source: {
        ...latestEvent.source,
        rawMessageId: latestLog.externalMessageId ?? latestEvent.source.rawMessageId
      },
      payload: { kind: "text", text },
      meta: {
        ...latestEvent.meta,
        replyTo: latestLog.externalMessageId ?? latestEvent.meta.replyTo,
        raw: {
          batchedFromMessageLog: true,
          pendingIds: pending.map((entry) => entry.id),
          contextCount: allSessionLogs.length,
          originalRaw: latestEvent.meta.raw
        }
      }
    };
  }

  return {
    id: createId("evt"),
    source: {
      plugin: latestLog.plugin,
      channelId: channelIdFromRecoveredMessage(latestLog),
      userId: userIdFromRecoveredMessage(latestLog),
      rawMessageId: latestLog.externalMessageId
    },
    externalSession: {
      scope: "dm",
      sessionId
    },
    type: "message.text",
    payload: { kind: "text", text },
    meta: {
      receivedAt: latestLog.createdAt,
      receivedAtUtc: latestLog.createdAtUtc,
      replyTo: latestLog.externalMessageId,
      raw: {
        recoveredFromMessageLog: true,
        pendingIds: pending.map((entry) => entry.id)
      }
    }
  };
}

export function buildManualProcessEvent(
  target: NonNullable<ReturnType<NonNullable<MessageRuntimeDeps["getProcessNowTarget"]>>>,
  time: CurrentTimeProvider
): AgentEvent {
  const receivedTime = time.now();
  const receivedAt = receivedTime.iso;
  const receivedAtUtc = receivedTime.date.toISOString();
  return {
    id: createId("evt"),
    source: {
      plugin: target.plugin,
      accountId: target.accountId,
      channelId: target.channelId,
      userId: target.userId
    },
    externalSession: {
      scope: "dm",
      sessionId: target.sessionId
    },
    type: "message.text",
    payload: {
      kind: "text",
      text: "A manual process-now event was requested from the admin panel. Use messaging tools to inspect conversation history before replying."
    },
    meta: {
      receivedAt,
      receivedAtUtc,
      raw: {
        adminProcessNow: true
      }
    }
  };
}


function channelIdFromRecoveredMessage(message: StoredConversationMessage): string {
  if (message.plugin === "wechat") return userIdFromWechatConversationId(message.conversationId);
  return message.conversationId;
}

function userIdFromRecoveredMessage(message: StoredConversationMessage): string | undefined {
  if (message.plugin === "wechat") return userIdFromWechatConversationId(message.conversationId);
  return message.senderId;
}

function userIdFromWechatConversationId(conversationId: string): string {
  return conversationId.startsWith("wechat:dm:") ? conversationId.slice("wechat:dm:".length) : conversationId;
}
