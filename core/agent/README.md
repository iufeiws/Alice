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

- `check_feishu({ scope = "today" })`: 查看当前一对一飞书聊天记录。`scope="new"` 返回上次查看后的新增飞书消息。
- `send_feishu({ type = "message", content })`: 发送飞书消息到当前一对一聊天。`message` 模式会把换行分隔内容拆成多条飞书消息，并按内容字数节流发送；发送尝试会立即占用节流窗口，失败后进入内存重试队列。

Tool results are plain strings in the same compact format shown to the LLM. The first adapter behind these tools is Feishu, but the LLM-facing names intentionally do not include Feishu.

When the configured LLM adapter supports streaming, AgentCore watches `send_feishu` tool-call argument deltas. For `type="message"`, every decoded newline in `content` immediately sends the completed line, so long multi-message replies do not wait for the final JSON arguments object.

If `send_feishu` appears in a tool-call response, AgentCore treats it as the terminal action for that inbound event. It executes only `send_feishu` calls from that response, skips any mixed read/search calls, and does not feed the send result back into another LLM round. This rule is intentional so future prompt/tool policy updates do not reintroduce repeated read/send loops.
