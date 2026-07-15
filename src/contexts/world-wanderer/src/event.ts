import type { AgentEvent } from "../../agent-loop/src/contracts/agent-contracts.js";
import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";
import { createId } from "../../../shared/uuid/src/index.js";
import type { AgentHeartbeatTick } from "../../agent-loop/src/runtime/agent-heartbeat-runtime.js";
import type { ProactiveEvent } from "../../initiative/src/application/proactive-event-queue.js";

export function buildWorldWandererTargetReachedEvent(
  target: { plugin: string; accountId?: string; channelId?: string; userId?: string; sessionId: string },
  time: CurrentTimeProvider
): AgentEvent {
  const receivedTime = time.now();
  return {
    id: createId("world_wanderer_target_reached"),
    source: { plugin: target.plugin, accountId: target.accountId, channelId: target.channelId, userId: target.userId },
    externalSession: { scope: "dm", sessionId: target.sessionId },
    type: "system.heartbeat",
    payload: { kind: "text", text: "" },
    meta: {
      receivedAt: receivedTime.iso,
      receivedAtUtc: receivedTime.date.toISOString(),
      raw: { agentInitiatedTriggerEvent: "world_wanderer.target_reached" }
    }
  };
}

export function createWorldWandererHeartbeatTick(input: {
  isDue(): boolean;
  canRun(): boolean;
  getDelayMs(): number | undefined;
  poll(delayMs: number): Promise<AgentEvent | undefined> | AgentEvent | undefined;
  enqueue(event: ProactiveEvent): void;
  appendLog(level: "warn", message: string): void;
}): AgentHeartbeatTick {
  return async (options) => {
    if (options.force || !input.isDue() || !input.canRun()) return;
    try {
      const event = await input.poll(input.getDelayMs() ?? 0);
      if (event) input.enqueue({ event, label: "idle timer transition", waitingReason: "idle_timer_transition" });
    } catch (error) {
      input.appendLog("warn", `idle timer transition hook failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
