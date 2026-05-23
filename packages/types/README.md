# Shared Types

`packages/types` defines the internal protocol between AgentCore and plugins.

## AgentEvent

Normalized inbound event. Channel plugins convert external messages into this shape.

Important fields:

- `source.plugin`: source plugin id, for example `feishu`.
- `source.channelId`: external chat/channel id.
- `source.userId`: external user id.
- `session.scope`: `dm`, `group`, `topic`, `admin`, or `desktop`.
- `type`: event kind, for example `message.text`.
- `payload`: normalized payload.
- `meta.raw`: original platform event for debugging.

## AgentOutput

Normalized outbound message. AgentCore emits this and channel plugins render it.

Supported content kinds include:

- `text`
- `markdown`
- `html`
- `card`
- `image`
- `audio`
- `file`

## Plugin Interfaces

```ts
interface ChannelPlugin {
  id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(output: AgentOutput): Promise<void>;
}

interface ToolPlugin {
  id: string;
  listTools(): ToolDefinition[];
  execute(call: ToolCall): Promise<ToolResult>;
}
```

Tool plugins are defined but not used by the current runtime.
