# Shared Types 说明

`packages/types` 定义 AgentCore 与 plugins 之间的内部协议。

## AgentEvent

规范化入站事件。Channel Plugin 会把外部消息转换成这个形态。

重要字段：

- `source.plugin`：来源 plugin id，例如 `feishu`。
- `source.channelId`：外部 chat/channel id。
- `source.userId`：外部 user id。
- `session.scope`：`dm`、`group`、`topic`、`admin` 或 `desktop`。
- `type`：事件类型，例如 `message.text`。
- `payload`：规范化 payload。
- `meta.raw`：用于调试的原始平台事件。

支持的 payload kind 包括 `text`、`markdown`、`image`、`audio`、`file`、`link` 和 `card_action`。

## AgentOutput

规范化出站消息。AgentCore 产出它，Channel Plugin 负责渲染和发送。

支持的内容类型包括：

- `text`
- `markdown`
- `html`
- `card`
- `image`
- `audio`
- `file`

## Plugin Interfaces 说明

```ts
interface ChannelPlugin {
  id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(output: AgentOutput): Promise<unknown>;
}

interface ToolPlugin {
  id: string;
  listTools(): ToolDefinition[];
  execute(call: ToolCall): Promise<ToolResult>;
}
```

`send()` 可以返回平台发送元数据。飞书在平台响应包含 message id 时会返回 `{ messageId }`，这样 storage 可以更新出站消息状态。

Tool plugins 会在 OpenAI 兼容 tool-call 回合中由 AgentCore 执行。`ToolCall` 包含调用来自哪个 requester source 与 session。
`ToolResult.invalidateLLMSession` 可要求 AgentCore 在工具执行后清理活跃 LLM 会话。
