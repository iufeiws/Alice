import type { AgentEvent } from "../../../packages/types/src/index.js";

export type EventHandler = (event: AgentEvent) => Promise<void> | void;

export interface EventBus {
  publish(event: AgentEvent): Promise<void>;
  subscribe(handler: EventHandler): () => void;
}

export function createInMemoryEventBus(): EventBus {
  const handlers = new Set<EventHandler>();

  return {
    async publish(event) {
      await Promise.all([...handlers].map((handler) => handler(event)));
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    }
  };
}
