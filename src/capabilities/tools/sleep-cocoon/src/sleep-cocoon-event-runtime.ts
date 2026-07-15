import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import { parseZonedIso } from "../../../../platform/time/src/index.js";
import { createId } from "../../../../shared/uuid/src/index.js";
import { sleepCocoonHazardProbability } from "./sleep-cocoon-math.js";
import type { MessagingToolTarget } from "../../messaging/src/index.js";
import type { AgentHeartbeatTick } from "../../../../contexts/agent-loop/src/runtime/agent-heartbeat-runtime.js";
import type { ProactiveEvent } from "../../../../contexts/initiative/src/application/proactive-event-queue.js";
import type { AgentEvent } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";

type SleepCocoonAgentState = {
  getSnapshot(): { state: string; sleepCocoonEnteredAt?: string; sleepCocoonEnteredAtUtc?: string; sleepCocoonAutoCheckedAt?: string };
  setState(state: string, options?: Record<string, unknown>): unknown;
  canRunHeartbeat(): boolean;
  noteSleepCocoonAutoChecked(): unknown;
};

export function createSleepCocoonEventRuntime(input: {
  agentState: SleepCocoonAgentState;
  time: CurrentTimeProvider;
  getDefaultTarget(): MessagingToolTarget | undefined;
  random?: () => number;
}) {
  const random = input.random ?? Math.random;
  const pendingMorningEvents: Array<NonNullable<ReturnType<typeof buildGeneratedEvent>>> = [];

  return {
    maybeBuildGoodnightEvent,
    queueMorningEvent(raw: Record<string, unknown>) {
      const event = buildGeneratedEvent("sleep_cocoon_morning", raw);
      if (event) pendingMorningEvents.push(event);
    },
    queueForceWakeEvent(raw: Record<string, unknown>) {
      const event = buildGeneratedEvent("sleep_cocoon_force_wake", raw);
      if (event) pendingMorningEvents.push(event);
    },
    consumeMorningEvent() {
      return pendingMorningEvents.shift();
    },
    buildGeneratedEvent
  };

  function maybeBuildGoodnightEvent() {
    const snapshot = input.agentState.getSnapshot();
    if (!snapshot.sleepCocoonEnteredAt) return undefined;
    if (snapshot.state !== "idle") return undefined;
    if (!input.agentState.canRunHeartbeat()) return undefined;
    const enteredAt = parseZonedIso(snapshot.sleepCocoonEnteredAt, input.time.timeZone).getTime();
    const nowMs = input.time.now().epochMs;
    const elapsedHours = (nowMs - enteredAt) / (60 * 60 * 1000);
    if (elapsedHours < 22) return undefined;
    const target = input.getDefaultTarget();
    if (!target) return undefined;

    const previousCheckHours = snapshot.sleepCocoonAutoCheckedAt
      ? Math.max(22, (parseZonedIso(snapshot.sleepCocoonAutoCheckedAt, input.time.timeZone).getTime() - enteredAt) / (60 * 60 * 1000))
      : 22;
    const currentHours = Math.max(previousCheckHours, elapsedHours);
    const probability = sleepCocoonHazardProbability(previousCheckHours, currentHours);
    const triggered = random() < probability;
    input.agentState.noteSleepCocoonAutoChecked();
    if (!triggered) return undefined;
    return buildGeneratedEvent("sleep_cocoon_goodnight", { agentInitiatedTriggerEvent: "sleep_cocoon.auto_goodnight_check" });
  }

  function buildGeneratedEvent(idPrefix: string, raw: Record<string, unknown>) {
    const target = input.getDefaultTarget();
    if (!target) return undefined;
    const receivedTime = input.time.now();
    const receivedAt = receivedTime.iso;
    const receivedAtUtc = receivedTime.date.toISOString();
    return {
      id: createId(idPrefix),
      source: {
        plugin: target.plugin,
        accountId: target.accountId,
        channelId: target.channelId,
        userId: target.userId
      },
      externalSession: {
        scope: "dm" as const,
        sessionId: target.sessionId
      },
      type: "system.heartbeat" as const,
      payload: {
        kind: "text" as const,
        text: `${idPrefix} mode should run now.`
      },
      meta: {
        receivedAt,
        receivedAtUtc,
        raw
      }
    };
  }
}

export function createSleepCocoonHeartbeatTick(input: {
  canRun(): boolean;
  hasPendingUserMessages(): boolean;
  getWakeEvent(): AgentEvent | undefined;
  getGoodnightEvent(): AgentEvent | undefined;
  enqueue(event: ProactiveEvent): void;
}): AgentHeartbeatTick {
  return (options) => {
    if (options.force || !input.canRun()) return;
    const wake = input.getWakeEvent();
    if (wake) input.enqueue({ event: wake, label: "sleep cocoon wake" });
    if (input.hasPendingUserMessages()) return;
    const goodnight = input.getGoodnightEvent();
    if (goodnight) input.enqueue({ event: goodnight, label: "sleep cocoon goodnight" });
  };
}
