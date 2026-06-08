export type EventHandler<TEvent = unknown> = (event: TEvent) => Promise<void> | void;

export interface EventBus<TEvent = unknown> {
  publish(event: TEvent): Promise<void>;
  subscribe(handler: EventHandler<TEvent>): () => void;
}

export function createInMemoryEventBus<TEvent = unknown>(): EventBus<TEvent> {
  const handlers = new Set<EventHandler<TEvent>>();

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
