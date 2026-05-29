# Agent Core 说明

AgentCore 负责平台无关的 Agent 回合。它接收规范化的 `AgentEvent`，路由意图，渲染 prompt 上下文，调用 LLM client，执行 tool calls，并返回规范化的 `AgentOutput`。

## 公共接口

```ts
createAgentCore(deps: AgentCoreDeps): AgentCore
```

`AgentCore` 暴露：

- `start(): Promise<void>`
- `stop(): Promise<void>`
- `handleEvent(event: AgentEvent): Promise<AgentOutput[]>`
- `getState(): AgentStateSnapshot | undefined`
- `registerChannel(plugin: ChannelPlugin): void`
- `clearLLMSession(reason: "admin_clear" | "shutdown"): void`

## 依赖

`AgentCoreDeps` 包括：

- `config`：运行时配置。
- `llm`：`LLMClient`。
- `intentRouter`：把文本路由为 chat 或 command intent。
- `sessionResolver`：返回稳定 session id。
- `policy`：Core 层策略检查。
- `outputRouter`：渠道发送注册表。
- `tools`：可选的平台无关工具，暴露给 OpenAI 兼容 function calling。
- `getPromptProfile` / `getDailyShell`：提供可编辑 prompt 与每日 shell。
- LLM 会话回调：用于管理后台记录活跃请求链、响应和清理事件。

## 当前行为

- 非文本 payload 返回不支持消息。
- `/codex ...` 返回占位 Markdown 响应。
- 文本聊天会调用配置的 LLM。
- 文本聊天可以在有限轮数内执行 tool-call，然后生成最终回复。
- Prompt append layers 可以加入每次心跳上下文，包括 `check_chat` 这类工具结果。
- AgentCore 会维护活跃 LLM 会话；静态 prompt 指纹变化、后台清理或 shutdown 会清理该会话。
- 每分钟最多发起 10 次 LLM 请求；单次事件最多 12 轮 LLM 请求、20 次 tool call。相同 tool call 连续重复 3 次或 `send_chat` 达到 5 次也会停止继续递归。

活跃 prompt 来自 `memory-files/config/prompt-profile.json` 中可编辑的 prompt profile。管理后台可修改层顺序、层内容、层角色、用户名和可见工具组。

Prompt 层支持运行时变量：

- `{{date_time}}`：本地日期和时间，格式为 `YYYY-MM-DD HH:mm:ss`
- `{{time}}`：本地时间，格式为 `HH:mm:ss`
- `{{date}}`：本地日期，格式为 `YYYY-MM-DD`
- `{{timezone}}`：当前时区
- `{{user}}`
- `{{session}}`
- `{{channel}}`

未知变量会按原样保留。

## Messaging Tools 说明

当前运行时向 LLM 暴露平台无关的聊天工具名：

- `check_chat()`：查看聊天记录。同一 LLM 会话内首次调用返回全局最近 50 条消息；后续调用返回全局第一条未读用户消息之后的上下文，并把读到的用户消息标记为已读。
- `search_messages({ content, direction?, limit?, contextCount? })`：搜索持久化消息，并返回命中附近的上下文块。当前搜索按目标 plugin 过滤，尚未按具体会话过滤。
- `send_chat({ type, content })`：发送消息到当前聊天会话。调用时应先提供 `type`，再提供 `content`。`message` 和 `voice` 模式会把换行分隔内容拆成多条消息，并按内容字数节流发送；`voice` 模式会把每段 `content` 文字合成为语音后发送。
- `selfie({ action, aspectRatio? })`：生成并发送一张 Alice 自拍；默认 `aspectRatio` 为 `3:4`，连续两次调用会被拒绝。
- `wardrobe({ action, name? })`：查看或切换服装。`action="list"` 返回衣橱，可用 `name` 模糊过滤；`action="switch"` 按服装名切换服装，不写壳切换提示。

工具结果是给 LLM 的紧凑纯文本。Messaging 工具本身平台无关，会优先路由到当前入站事件对应的 target；管理后台试用工具会显式选择飞书或微信默认 target。

当配置的 LLM adapter 支持 streaming 时，AgentCore 会监听 `send_chat` 的 tool-call argument delta。出现 `type="message"` 或 `type="voice"` 之后，`content` 中每个成功解码的换行都会立刻发送已完成的一行，使长的多段回复不必等完整 JSON arguments 结束。如果 `type` 缺失或晚于 `content` 到达，AgentCore 会等最终 JSON arguments 可用后再发送。

如果 tool-call 响应里出现 `send_chat`，AgentCore 会把它视为当前入站事件的终止动作。它只执行该响应里的 `send_chat` 调用，跳过混在一起的读取/搜索调用，也不会把发送结果再喂回下一轮 LLM。这个规则用于避免未来 prompt/tool policy 更新重新引入重复 read/send 循环。
