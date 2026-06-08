# Event Bus 说明

`core/event-bus` 提供一个小型内存 pub/sub 抽象。

## 公共接口

```ts
type EventHandler = (event: AgentEvent) => Promise<void> | void;

interface EventBus {
  publish(event: AgentEvent): Promise<void>;
  subscribe(handler: EventHandler): () => void;
}
```

## 工厂函数

```ts
createInMemoryEventBus(): EventBus
```

## 当前状态

Event bus 已可用，但当前 API 进程还没有把它作为中心路径。飞书插件现在通过 `deps.onEvent` 直接调用 AgentCore。
