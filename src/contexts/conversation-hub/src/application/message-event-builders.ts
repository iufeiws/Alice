import type { AgentEvent } from "../../../agent-loop/src/contracts/agent-contracts.js";
import { createId } from "../../../../shared/uuid/src/index.js";
import {
  defaultAgentInitiatedBehaviorPlans,
  hasRandomizedAgentInitiatedBehaviorPlan
} from "../../../../contexts/initiative/src/domain/initiated-behavior.js";
import { parseZonedIso } from "../../../../platform/time/src/index.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { StoredConversationMessage } from "../../../../contexts/conversation-hub/src/adapters/sqlite-conversation-store.js";
import type { MessageRuntimeDeps } from "./message-runtime-contracts.js";

export function buildRandomizedInitiatedBehaviorEvent(input: {
  deps: MessageRuntimeDeps;
  now: () => Date;
  random: () => number;
  time: CurrentTimeProvider;
}): AgentEvent | undefined {
  const { deps, now, random, time } = input;
  const lastMessage = deps.store.listMessages(1).at(-1);
  if (!lastMessage) return undefined;
  const lastMessageAt = messageTimestamp(lastMessage, time.timeZone);
  if (lastMessageAt === undefined) return undefined;
  const elapsedMs = Math.max(0, now().getTime() - lastMessageAt);
  const probability = Math.min(elapsedMs / (4 * 60 * 60 * 1000), 1) / 2;
  if (random() >= probability) return undefined;
  if (!hasRandomizedAgentInitiatedBehaviorPlan(deps.getAgentInitiatedBehaviorPlans?.() ?? defaultAgentInitiatedBehaviorPlans)) return undefined;
  const target = deps.getRandomInitiatedBehaviorTarget?.() ?? deps.getProcessNowTarget?.();
  if (!target) return undefined;
  const receivedTime = time.now();
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
    type: "system.heartbeat",
    payload: {
      kind: "text",
      text: "A randomized proactive event was triggered. Use messaging tools to inspect context before sending a short, low-interruption message."
    },
    meta: {
      receivedAt: receivedTime.iso,
      receivedAtUtc: receivedTime.date.toISOString(),
      raw: {
        agentInitiatedTriggerEvent: "randomized"
      }
    }
  };
}

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

function messageTimestamp(message: StoredConversationMessage, timeZone: string): number | undefined {
  const utcTimestamp = message.createdAtUtc ? Date.parse(message.createdAtUtc) : Number.NaN;
  if (Number.isFinite(utcTimestamp)) return utcTimestamp;
  const localTimestamp = parseZonedIso(message.createdAt, timeZone).getTime();
  return Number.isFinite(localTimestamp) ? localTimestamp : undefined;
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
