# Session Resolver 说明

`core/session` 从规范化事件创建稳定的内部 session id。

## 公共接口

```ts
interface SessionResolver {
  resolve(event: AgentEvent): Promise<string>;
}
```

## 工厂函数

```ts
createSessionResolver(): SessionResolver
```

## 当前规则

如果 `event.session.sessionId` 已存在，直接返回。否则按以下形式派生：

```text
{plugin}:{scope}:{threadId | channelId | userId | rawMessageId | eventId}
```

飞书当前会在 AgentCore 运行前通过 binding store 提供 session id。
