import type { AgentEvent } from "../../../agent-loop/src/contracts/agent-contracts.js";
import type { AgentHeartbeatTick } from "../../../agent-loop/src/runtime/agent-heartbeat-runtime.js";

export type ProactiveEvent = {
  event: AgentEvent;
  label: string;
  waitingReason?: string;
};

export function createProactiveEventQueue() {
  const events: ProactiveEvent[] = [];
  return {
    enqueue(event: ProactiveEvent): void {
      events.push(event);
    },
    dequeue(): ProactiveEvent | undefined {
      return events.shift();
    },
    isEmpty(): boolean {
      return events.length === 0;
    }
  };
}

export function createProactiveEventConsumerTick(input: {
  queue: ReturnType<typeof createProactiveEventQueue>;
  canRun(): boolean;
  beforeRun?(event: ProactiveEvent): Promise<void> | void;
  run(event: ProactiveEvent): Promise<boolean>;
  setWaiting(reason: string): void;
}): AgentHeartbeatTick {
  return async (options) => {
    if (options.force || !input.canRun()) return;
    const event = input.queue.dequeue();
    if (!event) return;
    await input.beforeRun?.(event);
    const processed = await input.run(event) ? 1 : 0;
    if (event.waitingReason) input.setWaiting(event.waitingReason);
    return { processed, stop: true };
  };
}
