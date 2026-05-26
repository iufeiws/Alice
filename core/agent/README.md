# Agent Core

AgentCore owns the platform-independent agent turn. It receives normalized `AgentEvent` objects, routes intent, optionally recalls memory, calls the LLM client, captures memory, and returns normalized `AgentOutput` objects.

## Public Interface

```ts
createAgentCore(deps: AgentCoreDeps): AgentCore
```

`AgentCore` exposes:

- `start(): Promise<void>`
- `stop(): Promise<void>`
- `handleEvent(event: AgentEvent): Promise<AgentOutput[]>`
- `registerChannel(plugin: ChannelPlugin): void`

## Dependencies

`AgentCoreDeps` includes:

- `config`: runtime config.
- `llm`: `LLMClient`.
- `intentRouter`: routes text into chat or command intent.
- `sessionResolver`: returns a stable session id.
- `policy`: core policy check.
- `outputRouter`: channel send registry.
- `memory`: optional `recall(event)` and `capture(event, outputs)` hooks.
- `tools`: optional platform-neutral tools exposed to OpenAI-compatible function calling.

## Current Behavior

- Non-text payloads return an unsupported message.
- `/codex ...` returns a placeholder markdown response.
- Text chat calls the configured LLM.
- Text chat can execute a bounded number of tool-call rounds before producing the final reply.
- Recalled memories are injected as an extra system message.
- Text turns are captured after the LLM response.

The system prompt currently comes from `core/agent/src/prompts.ts`.

## Messaging Tools

The current runtime exposes platform-neutral tool names to the LLM:

- `view_messages({ scope = "today" })`: reads current-conversation messages. `scope="new"` returns messages since the last tool view cursor.
- `search_messages({ content, direction = "backward", limit = 3, contextCount = 10 })`: searches persisted current-conversation messages with SQLite FTS5 and returns context blocks.
- `send_message({ type = "message", content })`: sends to the current conversation. `message` mode splits newline-separated content into multiple messages sent 500 ms apart.

Tool results are plain strings in the same compact format shown to the LLM. The first adapter behind these tools is Feishu, but the LLM-facing names intentionally do not include Feishu.

When the configured LLM adapter supports streaming, AgentCore watches `send_message` tool-call argument deltas. For `type="message"`, every decoded newline in `content` immediately sends the completed line, so long multi-message replies do not wait for the final JSON arguments object.
