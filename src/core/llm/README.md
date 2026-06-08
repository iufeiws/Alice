# LLM Adapter 说明

内部 OpenAI 兼容 `/v1` 客户端，用于 OpenAI、DeepSeek、opencode 和类似 provider。

## 公共接口

```ts
interface LLMClient {
  chat(input: LLMChatInput): Promise<LLMChatResult>;
  chatStream?(input: LLMChatInput, handlers?: LLMStreamHandlers): Promise<LLMChatResult>;
  listModels?(): Promise<LLMModel[]>;
}
```

## 工厂函数

- `createOpenAICompatibleClient(config)`：调用 `${baseURL}/chat/completions` 和 `${baseURL}/models`。
- `createStubLLMClient()`：未配置 API key 或 base URL 时使用的本地 fallback。

## 请求形态

OpenAI 兼容客户端发送：

```ts
{
  model,
  messages,
  temperature,
  tools,
  max_tokens,
  ...extraParams
}
```

它期望 OpenAI 风格的 `choices[0].message.content`，并把 usage 字段规范化为 `LLMUsage`。

## Tool Calling 说明

适配器支持 OpenAI 风格 chat tools：

- 请求中的 `tools` 会作为 function tool specs 透传。
- assistant 的 `tool_calls` 会规范化为 `LLMMessage.toolCalls`。
- assistant 的 `reasoning_content` 会规范化为 `LLMMessage.reasoningContent`，再序列化回后续请求。
- `tool` role 消息会带 `tool_call_id` 序列化。
- 当 `chatStream()` 可用时，会解析 streaming `/chat/completions` 的 SSE 响应，包括增量 tool-call argument delta。

工具执行归 AgentCore 管理，不属于 LLM adapter 职责。

## 配置

API host 从以下变量构建客户端：

- `LLM_BASE_URL`
- `LLM_API_KEY`
- `LLM_MODEL`
- `LLM_TEMPERATURE`
- `LLM_TIMEOUT_MS`
- `LLM_STREAM_ENABLED`
- `LLM_EXTRA_PARAMS`
- `LLM_FOLLOWUP_EXTRA_PARAMS`

`LLM_EXTRA_PARAMS` 会合并到首轮 chat/completions 请求。`LLM_FOLLOWUP_EXTRA_PARAMS` 未设置时会沿用 `LLM_EXTRA_PARAMS`；设置为空对象字符串 `{}` 可让后续 tool-call 轮次不带首轮额外参数。
