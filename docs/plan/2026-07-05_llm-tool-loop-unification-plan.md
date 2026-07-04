# LLM Tool Loop 统一执行验收目标

## 背景

当前问题不是某个 Chat 分支的局部 bug，而是 tool 执行职责被分散到了不同 loop / Agent 中。验收目标是把 LLM function-call loop 的 tool 执行收回到统一路径，删除已经证明无用或误导的状态字段，避免继续通过 Chat/Talk/Agent 类型制造不同执行语义。

## 总目标

- `runLLMToolLoop` 是唯一 LLM function-call loop。
- tool call 执行发生在 `runLLMToolLoop` 内部。
- 所有 LLM tool call 走同一个 `executeTool(...)`。
- Chat/Talk/其他 Agent loop 不提供、不可见、也不包装 tool execution。
- tool/plugin 自己承担具体执行语义，loop 不根据 Agent 类型、loop 类型、requester、channel 或 tool name 分叉执行。

## 必须删除

- 删除 `LLMToolLoopInput.executeTool` 这类由外层 loop 提供执行函数的入口。
- 删除 `toolRuntime`、resolver、builder 或其他换名后的外层执行配置入口。
- 删除 Chat/Talk 私有 tool execution 分支。
- 删除 `sentMessage`。
- 删除 `onLLMSessionCompleted({ sentMessage })`。
- 删除重复的 `llmSessionBusy` mirror。
- 删除 `messageCursorId` 链路：
  - `ToolResult.messageCursorId`
  - `lastCheckChatCursorMessageId`
  - `fixedPrefixCursorMessageId`
  - `from_prefix`
  - `__fromPrefixAfterMessageId`
  - 依赖这些字段的 preview、session metadata 和测试
- 删除之前错误加入的 Yield resume hook / immediate resume 分叉。

## 统一执行规则

- `runLLMToolLoop` 收到 LLM tool call 后，内部调用统一 `executeTool(...)`。
- `executeTool(...)` 不区分 Chat/Talk/Memory/Agent 类型。
- `executeTool(...)` 不根据 requester、channel、loop kind 或 tool name 做特殊拦截。
- `executeTool(...)` 的职责只包括：
  - 按 tool name 查找已暴露的 tool/plugin。
  - 解析 LLM tool arguments 为 `ToolCall.input`。
  - 调用同一个 `ToolPlugin.execute` 路径。
  - 格式化 tool result 给 LLM。
  - 应用通用 tool result control。
- 已经暴露给 LLM 的 tool call 必须执行；不可用能力只能在 request 构筑阶段通过 visible tools / `toolNames` 控制。

## Loop 职责边界

- `runLLMToolLoop` 负责 model -> tools -> model 的顺序。
- `runLLMToolLoop` 负责保证 assistant tool use 与 tool result 紧邻写回。
- `runLLMToolLoop` 负责 limit、reset、invalidate、yield return 等通用 loop control。
- Agent loop 只负责准备 LLM request、维护自己的 session transcript、处理请求前后生命周期。
- Agent loop 不判断“是否发送了消息”“投递到哪里”“是否有对外输出”。

## Tool 职责边界

- tool/plugin 自己通过依赖和 capability 处理具体行为。
- 输出目标解析属于 capability / tool 层，不属于 loop。
- 外部 session、requester、上下文等只作为 tool execution context 传递，不用于 loop 分叉。

## Yield 和 Interrupt 边界

- 本轮不实现 Alert / Interrupt 插入位置。
- 不新增隐藏 prompt。
- 不把 Alert 硬编码进 runtime prompt。
- 不把 user message 或 Alert 插到 tool use 和 tool result 中间。
- Yield 继续走原有正常 loop 返回路径。
- 如果未来处理“LLM 运行中收到新用户消息”，必须保持 tool result 紧跟对应 tool use。

## Prompt 边界

- 不新增任何运行时隐藏 prompt。
- 如果未来需要 Alert layer，必须是 prompt layer 配置的一部分。
- Prompt Preview 必须能看到实际会发送给 LLM 的内容。

## 测试验收

- 不测试 prompt 文本内容。
- 测试结构和逻辑：
  - Chat/Talk spec 不再包含 tool execution。
  - `runLLMToolLoop` 内部统一执行 tool。
  - 所有 LLM tool call 走同一个 `ToolPlugin.execute`。
  - Yield 没有新增 resume hook 或分叉路径。
  - busy 状态来源只剩 `agentLoopRuntime.isRunning()` / active main session。
  - `messageCursorId`、`from_prefix`、`fixedPrefixCursorMessageId` 等字段和行为消失。
- `npm run typecheck` 通过。
- 相关 agent-loop、llm-tool-loop、messaging tool 测试通过，废弃 cursor 测试同步删除或改写。
