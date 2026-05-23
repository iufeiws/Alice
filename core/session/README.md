# Session Resolver

`core/session` creates stable internal session ids from normalized events.

## Public Interface

```ts
interface SessionResolver {
  resolve(event: AgentEvent): Promise<string>;
}
```

## Factory

```ts
createSessionResolver(): SessionResolver
```

## Current Rule

If `event.session.sessionId` already exists, it is returned. Otherwise the resolver derives:

```text
{plugin}:{scope}:{threadId | channelId | userId | rawMessageId | eventId}
```

Feishu currently supplies a session id through its binding store before AgentCore runs.
