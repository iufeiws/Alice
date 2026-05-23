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

## Configuration

The API host builds this client from:

- `LLM_BASE_URL`
- `LLM_API_KEY`
- `LLM_MODEL`
- `LLM_TEMPERATURE`
- `LLM_TIMEOUT_MS`
