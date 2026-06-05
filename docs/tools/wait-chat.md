# wait_chat 工具

`wait_chat` 是 messaging/chat 工具集合的一部分，用来让模型显式表示“当前没有要发送的消息，等待下一次聊天变化”。它不是独立的通用 wait tool，而应合并进现有 chat 工具边界，和 `check_chat` / `send_chat` 使用同一个 messaging tool plugin 暴露给 core。

核心语义有两个：

- 每轮收到 assistant tool calls 后，core 先检查这一组 tool calls 是否包含 `wait_chat`。
- 如果包含 `wait_chat`，outbound 工具立即执行并写入会话，inbound 工具和 `wait_chat` 的最终 tool result 等待下一次 resume 时补齐。

## 目标

- 在 messaging/chat 工具中新增 LLM 可见函数 `wait_chat`。
- `wait_chat` 首次执行时只返回控制 meta：`yieldReturn: true`，不立即生成 LLM transcript 里的 tool result。
- core 识别同一批 tool calls 中存在 `wait_chat` 后，立即处理 outbound 工具，并延后 inbound 工具。
- core 写入 assistant tool calls 和已完成 outbound tool results 后 yield 返回，不再向 LLM 发起下一轮请求。
- heartbeat 唤起后，如果当前 session 有未补齐的 `wait_chat` tool call，则先补齐剩余 inbound tool results，再补齐 `wait_chat` tool result。
- 该补全行为应替代默认 append layer 中的 fake `check_chat` assistant/tool 消息，避免上下文里出现“模型 wait 之后 core 又伪造 check_chat”的双重读取。

## 非目标

- 不实现定时唤醒或 sleep timer。
- 不暂停进程、阻塞事件循环或等待一段真实时间。
- 不清理 LLM session 上下文。
- 不替代 admin 的“撤销 LLM 运行”能力；admin cancel 仍然负责中断正在进行的请求或 loop。
- 不把 `wait_chat` 暴露给 memory induction、workspace 文件归纳等非聊天专用 loop。

## 工具归属

`wait_chat` 应合并进：

```text
tools/messaging/src/index.ts
```

而不是新增：

```text
tools/wait
```

原因：

- `tools/messaging` 是 chat 工具包；TTS 实现由 `plugins/tts` 提供，messaging 只调用注入的语音合成器。
- `wait_chat` 的唤醒条件来自聊天消息变化和 heartbeat。
- `wait_chat` 的续接结果来自 `check_chat`。
- 它需要复用当前 messaging session、requester、cursor 和 `messageCursorId` 语义。

`createMessagingTools(deps)` 的 `listTools()` 应返回：

- `check_chat`
- `send_chat`
- `wait_chat`

如果存在兼容别名，`wait_chat` 不需要 Feishu/Wechat 平台别名；它是 core/chat 层语义，不是平台发送接口。

## LLM-visible 定义

### wait_chat

等待聊天记录更新。当有新消息时会收到提醒并返回新消息。

输入：无。

Schema 建议：

```ts
const waitChatTool: ToolDefinition = {
  name: "wait_chat",
  description: "等待聊天记录更新。当有新消息时会收到提醒并返回新消息。",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
};
```

最终 description：

```text
等待聊天记录更新。当有新消息时会收到提醒并返回新消息。
```

首次执行的内部控制结果建议：

```ts
{
  callId: call.id,
  ok: true,
  meta: { yieldReturn: true }
}
```

这个结果只用于 core 控制 loop，不应作为 `wait_chat` tool message 写入 LLM transcript。首次调用后，本轮可以处于“yield 中”的临时 transcript 状态；core 已写入 assistant tool calls 和即时完成的 outbound tool results，但不会发起下一次 LLM 请求，直到 `wait_chat` 返回并补齐剩余 tool results。

## ToolResult 协议扩展

`packages/types/src/index.ts` 中的 `ToolResult` 需要支持一个控制 meta：

```ts
meta?: {
  yieldReturn?: boolean;
};
```

语义：

- `meta.yieldReturn === true` 表示当前 tool-call 批次进入等待态，本轮 agent loop yield 返回，不继续请求 LLM。
- 这是正常等待信号，不代表错误、取消、reset 或 invalidate。
- yield 发起时不生成 `wait_chat` tool result；返回时将 pending 状态标记为 `false` 或清除，再生成 `wait_chat` tool result。
- `wait_chat` 不应改变 `messageCursorId`；聊天读取 cursor 仍由返回时执行的 `check_chat` / inbound 工具结果控制。

## Core loop 行为

`core/agent/src/llm-tool-loop.ts` 需要支持 yield 型 tool-call 批处理。

建议扩展：

```ts
export type LLMToolLoopControl = {
  sentMessage?: boolean;
  invalidateSession?: boolean;
  resetSession?: boolean;
  continueAfterReset?: boolean;
  reachedToolCallLimit?: boolean;
  yieldReturn?: boolean;
};

export type LLMToolLoopStopReason =
  | "completed"
  | "empty_messages"
  | "tool_limit"
  | "reset"
  | "invalidated"
  | "cancelled"
  | "yield_return";
```

处理规则：

- 每轮收到 assistant tool calls 后，先扫描这一组 tool calls 是否包含 `wait_chat`。
- 如果不包含 `wait_chat`，按现有普通 tool loop 行为处理。
- 如果包含 `wait_chat`，本轮进入 yield 批处理：
  - outbound 类工具立即执行，并把 tool result 拼接进会话。outbound 包括发送、写入、切换等会立即产生外部副作用的工具，例如 `send_chat`。
  - inbound 类工具暂不执行，等待 `wait_chat` 返回后再处理。inbound 包括读取聊天、搜索、查看状态等观察型工具，例如 `check_chat`。
  - `wait_chat` 自身写入 pending meta：`yieldReturn: true`，并记录 wait 起点、原始 tool call 列表、已完成 tool result 和未完成 tool call。
  - core yield 返回，不再请求 LLM。
- yield 返回时，把 pending meta 标记为 `yieldReturn: false` 或清除，然后按原 tool call 顺序组装剩余 tool results，包括 inbound 工具结果和 `wait_chat` 结果。
- 补齐全部 tool results 后，core 才能继续向 LLM 发起下一轮请求。

## Heartbeat 续接行为

普通 heartbeat 唤起已有 session 时，core 可能通过 append layers 拼接 fake `check_chat` request/result：

```text
assistant tool_call: check_chat({})
tool result: check_chat(...)
```

新行为：

1. heartbeat 唤起时，先检查当前 active LLM session 是否存在未补齐 tool result 的 assistant tool calls。
2. 如果这组 pending tool calls 中包含 `wait_chat`，进入 wait-chat resume 路径。
3. resume 路径先把 pending wait 标记为非 yield 状态，再执行剩余 inbound 工具。内部 `check_chat` 参数沿用原本 append/fixed-prefix 规则：
   - 普通 session：等价于默认 append `check_chat({})`。
   - fixed-prefix session：等价于 `scope=from_prefix`，并带上 `__fromPrefixAfterMessageId`。
4. core 不追加 fake `check_chat` assistant message。
5. core 将剩余 tool results 按原 tool call 顺序追加到 session；其中 `wait_chat` 的 tool result 使用等待返回时的聊天检查结果。

追加后的上下文形态应是：

```text
assistant tool_call: wait_chat({})
tool result: wait_chat("<本次 check_chat 的结果>")
```

这表示上一轮 `wait_chat` 被新的聊天检查结果续接，而不是 core 自己发起了一个新的 LLM-visible `check_chat`。

如果同一轮还有其他 tool call，不丢弃任何 tool call。outbound 先执行，inbound 和 `wait_chat` 等返回后补齐：

```text
assistant tool_call: send_chat({"type":"message","content":"..."})
assistant tool_call: check_chat({})
assistant tool_call: wait_chat({})
tool result: send_chat(...)
```

下一次 heartbeat 再追加：

```text
tool result: check_chat(...)
tool result: wait_chat("<本次 check_chat 的结果>")
```

## 返回格式示例

`wait_chat` 的 heartbeat resume 结果应尽量复用 `check_chat` 的输出格式，只额外加入等待时长。等待时长从上一轮执行 `wait_chat` 的时间开始计算，到本次内部 `check_chat` 执行时间结束。

有新消息时：

```text
<chat-log>
[2026-06-04 14:03] user: 在吗？
</chat-log>
<wait-duration>5m</wait-duration>
<time>2026-06-04T14:03:25.120</time>
```

没有新消息时：

```text
<chat-log>
nothing new
</chat-log>
<wait-duration>5m</wait-duration>
<time>2026-06-04T14:03:25.120</time>
```

字段规则：

- `<chat-log>`：与 `check_chat` 结果一致，包含 timeline blocks 或 `nothing new`。
- `<wait-duration>`：只在 `wait_chat` resume 结果中出现，放在 `<time>` 前面；只输出给 LLM 阅读的人类可读时长，不带原始毫秒数，精确到分钟即可。
- `<time>`：与 `check_chat` 当前时间字段一致，使用当前 messaging tool 的时区时间；即使没有新消息，也必须使用本次 resume 的当前时间。
- 如果无法确定上一轮 wait 起点，core 应记录一条 error 日志，并且不要输出 `<wait-duration>`。

缺少起点时的输出：

```text
<chat-log>
nothing new
</chat-log>
<time>2026-06-04T14:03:25.120</time>
```

## Cursor 规则

- `wait_chat` 首次执行不更新 `lastCheckChatCursorMessageId`。
- heartbeat resume 时运行的内部 `check_chat` 会返回 `messageCursorId`。
- core 应用该 `messageCursorId` 更新 `session.lastCheckChatCursorMessageId`，与原 fake `check_chat` append 行为一致。
- fixed-prefix 下仍应维护 `fixedPrefixCursorMessageId` / `__fromPrefixAfterMessageId` 的原有语义。

## 注册边界

- `wait_chat` 由 messaging tool plugin 暴露给 core。
- admin 工具预览可以列出它，但执行预览时不会真正产生等待意义；如果保留预览，应只返回普通 `ok` 结果，不触发 loop 控制。
- prompt 的 chat tool 列表需要说明 `wait_chat` 的使用场景：已经检查聊天且无需回复时调用它等待后续消息。
- 同一轮包含 `send_chat` 和 `wait_chat` 时，`send_chat` 作为 outbound 工具即时执行，`wait_chat` 进入 yield；不要因为存在 `send_chat` 就过滤掉 `wait_chat`。

## 测试建议

- `tests/messaging-tools.test.ts`：验证 `listTools()` 暴露 `wait_chat`，执行后返回 `ok: true` 和 `meta.yieldReturn: true`。
- `core/agent/src/llm-tool-loop` 的测试：验证 `wait_chat` 控制信号映射到 `stopReason: "yield_return"`，并且不会继续请求下一轮 LLM。
- 多 tool call 测试：同一轮中 outbound 工具即时执行，inbound 工具和 `wait_chat` 等 resume 后补齐，不丢弃任何 tool call。
- core heartbeat 集成测试：pending wait resume 时，heartbeat append 不生成 fake `check_chat` assistant/tool 消息，而是按原 tool call 顺序补齐剩余 tool results。
- cursor 测试：heartbeat resume 的内部 `check_chat` 结果应更新 `lastCheckChatCursorMessageId`。
- fixed-prefix 测试：pending tool calls 包含 `wait_chat` 且 session 为 fixed-prefix 时，resume 使用 `scope=from_prefix` 和 `__fromPrefixAfterMessageId`。
