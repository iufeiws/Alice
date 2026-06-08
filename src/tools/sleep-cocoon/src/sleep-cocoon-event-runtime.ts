import type { CurrentTimeProvider } from "../../../core/time/src/index.js";
import { parseZonedIso } from "../../../core/time/src/index.js";
import type { AgentStateController } from "../../../core/agent/src/state.js";
import { createId } from "../../../packages/types/src/index.js";
import { sleepCocoonHazardProbability } from "./sleep-cocoon-math.js";
import type { DefaultMessagingTarget } from "../../messaging/src/default-target-runtime.js";

export function createSleepCocoonEventRuntime(input: {
  agentState: AgentStateController;
  time: CurrentTimeProvider;
  getDefaultTarget(): DefaultMessagingTarget | undefined;
  random?: () => number;
}) {
  const random = input.random ?? Math.random;
  let pendingMorningEvent: ReturnType<typeof buildGeneratedEvent> | undefined;

  return {
    maybeBuildGoodnightEvent,
    queueMorningEvent(raw: Record<string, unknown>) {
      pendingMorningEvent = buildGeneratedEvent("sleep_cocoon_morning", raw);
    },
    queueForceWakeEvent(raw: Record<string, unknown>) {
      pendingMorningEvent = buildGeneratedEvent("sleep_cocoon_force_wake", raw);
    },
    consumeMorningEvent() {
      const event = pendingMorningEvent;
      pendingMorningEvent = undefined;
      return event;
    },
    buildGeneratedEvent
  };

  function maybeBuildGoodnightEvent() {
    const snapshot = input.agentState.getSnapshot();
    if (!snapshot.sleepCocoonEnteredAt) return undefined;
    if (snapshot.state === "going_to_sleep" || snapshot.state === "sleeping") return undefined;
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
    return buildGeneratedEvent("sleep_cocoon_goodnight", { sleepCocoonGoodnight: true });
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
      session: {
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
