# LLM Adapter

Internal OpenAI-compatible `/v1` client for OpenAI, DeepSeek, opencode, and similar providers.

## Public Interface

```ts
interface LLMClient {
  chat(input: LLMChatInput): Promise<LLMChatResult>;
  listModels?(): Promise<LLMModel[]>;
}
```

## Factories

- `createOpenAICompatibleClient(config)`: calls `${baseURL}/chat/completions` and `${baseURL}/models`.
- `createStubLLMClient()`: local fallback used when no API key or base URL is configured.

## Request Shape

The OpenAI-compatible client sends:

```ts
{
  model,
  messages,
  temperature,
  tools,
  max_tokens
}
```

It expects OpenAI-style `choices[0].message.content` and normalizes usage fields into `LLMUsage`.

## Tool Calling

The adapter supports OpenAI-style chat tools:

- request `tools` are forwarded as function tool specs;
- assistant `tool_calls` are normalized into `LLMMessage.toolCalls`;
- `tool` role messages are serialized with `tool_call_id`.
- streaming `/chat/completions` responses are parsed from SSE when `chatStream()` is available, including incremental tool-call argument deltas.

Tool execution is owned by AgentCore, not the LLM adapter.

## Configuration

The API host builds this client from:

- `LLM_BASE_URL`
- `LLM_API_KEY`
- `LLM_MODEL`
- `LLM_TEMPERATURE`
- `LLM_TIMEOUT_MS`
