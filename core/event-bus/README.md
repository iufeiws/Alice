# Event Bus

`core/event-bus` provides a small in-memory pub/sub abstraction.

## Public Interface

```ts
type EventHandler = (event: AgentEvent) => Promise<void> | void;

interface EventBus {
  publish(event: AgentEvent): Promise<void>;
  subscribe(handler: EventHandler): () => void;
}
```

## Factory

```ts
createInMemoryEventBus(): EventBus
```

## Current Status

The event bus is available but not central to the current API process. The Feishu plugin calls AgentCore directly through `deps.onEvent`.
