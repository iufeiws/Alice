# Agent Core

AgentCore owns the platform-independent agent turn. It receives normalized `AgentEvent` objects, routes intent, renders prompt context, calls the LLM client, executes tool calls, and returns normalized `AgentOutput` objects.

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
- `tools`: optional platform-neutral tools exposed to OpenAI-compatible function calling.

## Current Behavior

- Non-text payloads return an unsupported message.
- `/codex ...` returns a placeholder markdown response.
- Text chat calls the configured LLM.
- Text chat can execute a bounded number of tool-call rounds before producing the final reply.
- Prompt append layers can add per-heartbeat context, including tool results such as `check_chat`.

The active prompt comes from the editable prompt profile in `memory-files/config/prompt-profile.json`.
The admin UI can change layer order, layer content, layer role, user name, and visible tool groups.

Prompt layers support runtime variables:

- `{{time}}`
- `{{date}}`
- `{{timezone}}`
- `{{user}}`
- `{{session}}`
- `{{channel}}`

Unknown variables are preserved as written.

## Messaging Tools

The current runtime exposes platform-neutral tool names to the LLM:

- `check_chat()`: 查看聊天记录。同一 LLM 会话内首次调用返回最近 50 条消息；后续调用返回新未读用户消息之后的上下文。
- `send_chat({ type, content })`: 发送消息到当前聊天会话。调用时应先提供 `type`，再提供 `content`。`message` 模式会把换行分隔内容拆成多条消息，并按内容字数节流发送；发送尝试会立即占用节流窗口，失败后进入内存重试队列。
- `wardrobe({ action, name? })`: 查看或切换服装。`action="list"` 返回衣橱，可用 `name` 模糊过滤；`action="switch"` 按服装名切换服装，不写壳切换提示。

Tool results are plain strings in the same compact format shown to the LLM. The tools are platform-neutral and route to the active messaging target.

When the configured LLM adapter supports streaming, AgentCore watches `send_chat` tool-call argument deltas. After `type="message"` has appeared, every decoded newline in `content` immediately sends the completed line, so long multi-message replies do not wait for the final JSON arguments object. If `type` is omitted or arrives after `content`, AgentCore waits until the final JSON arguments are available before sending.

If `send_chat` appears in a tool-call response, AgentCore treats it as the terminal action for that inbound event. It executes only `send_chat` calls from that response, skips any mixed read/search calls, and does not feed the send result back into another LLM round. This rule is intentional so future prompt/tool policy updates do not reintroduce repeated read/send loops.
