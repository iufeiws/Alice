import type { AgentEvent } from "../../../agent-loop/src/contracts/agent-contracts.js";
import type { AgentInitiatedBehaviorPlan } from "../domain/initiated-behavior.js";
import { defaultAgentInitiatedBehaviorPlans, hasRandomizedAgentInitiatedBehaviorPlan } from "../domain/initiated-behavior.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import { parseZonedIso } from "../../../../platform/time/src/index.js";
import { createId } from "../../../../shared/uuid/src/index.js";
import type { AgentHeartbeatTick } from "../../../agent-loop/src/runtime/agent-heartbeat-runtime.js";
import type { ProactiveEvent } from "./proactive-event-queue.js";

type Target = { plugin: string; accountId?: string; channelId?: string; userId?: string; sessionId: string };

export function buildRandomizedInitiatedBehaviorEvent(input: {
  listMessages(limit: number): Array<{ createdAt: string; createdAtUtc?: string }>;
  getPlans?(): AgentInitiatedBehaviorPlan[];
  getTarget(): Target | undefined;
  now(): Date;
  random(): number;
  time: CurrentTimeProvider;
}): AgentEvent | undefined {
  const lastMessage = input.listMessages(1).at(-1);
  if (!lastMessage) return undefined;
  const lastMessageAt = messageTimestamp(lastMessage, input.time.timeZone);
  if (lastMessageAt === undefined) return undefined;
  const probability = Math.min(Math.max(0, input.now().getTime() - lastMessageAt) / (4 * 60 * 60 * 1000), 1) / 2;
  if (input.random() >= probability) return undefined;
  if (!hasRandomizedAgentInitiatedBehaviorPlan(input.getPlans?.() ?? defaultAgentInitiatedBehaviorPlans)) return undefined;
  const target = input.getTarget();
  if (!target) return undefined;
  const receivedTime = input.time.now();
  return {
    id: createId("evt"),
    source: { plugin: target.plugin, accountId: target.accountId, channelId: target.channelId, userId: target.userId },
    externalSession: { scope: "dm", sessionId: target.sessionId },
    type: "system.heartbeat",
    payload: {
      kind: "text",
      text: "A randomized proactive event was triggered. Use messaging tools to inspect context before sending a short, low-interruption message."
    },
    meta: {
      receivedAt: receivedTime.iso,
      receivedAtUtc: receivedTime.date.toISOString(),
      raw: { agentInitiatedTriggerEvent: "randomized" }
    }
  };
}

export function createRandomizedInitiativeHeartbeatTick(input: {
  isDue(): boolean;
  canRun(): boolean;
  hasPendingUserMessages(): boolean;
  hasQueuedEvent(): boolean;
  build(): AgentEvent | undefined;
  enqueue(event: ProactiveEvent): void;
}): AgentHeartbeatTick {
  return (options) => {
    if (options.force || !input.isDue() || !input.canRun() || input.hasPendingUserMessages() || input.hasQueuedEvent()) return;
    const event = input.build();
    if (event) input.enqueue({ event, label: "randomized initiated behavior", waitingReason: "randomized_initiated_behavior" });
  };
}

function messageTimestamp(message: { createdAt: string; createdAtUtc?: string }, timeZone: string): number | undefined {
  const utcTimestamp = message.createdAtUtc ? Date.parse(message.createdAtUtc) : Number.NaN;
  if (Number.isFinite(utcTimestamp)) return utcTimestamp;
  const localTimestamp = parseZonedIso(message.createdAt, timeZone).getTime();
  return Number.isFinite(localTimestamp) ? localTimestamp : undefined;
}
