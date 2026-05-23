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

## Current Behavior

- Non-text payloads return an unsupported message.
- `/codex ...` returns a placeholder markdown response.
- Text chat calls the configured LLM.
- Recalled memories are injected as an extra system message.
- Text turns are captured after the LLM response.

The system prompt currently comes from `core/agent/src/prompts.ts`.
