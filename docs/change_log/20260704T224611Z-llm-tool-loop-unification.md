# LLM tool loop 执行路径与 fixed prefix 时间边界调整

日期：2026-07-05

## 背景

本次调整来自 ChatAgent、TalkAgent、Memory induction 等路径里 tool call 执行方式不一致的问题。目标是让 LLM 已经收到并调用的工具统一走 `ToolPlugin.execute`，由 LLM tool loop 持有执行入口；Agent 侧只提供 tool 名称、来源和上下文构造，不再直接提供 `ToolPlugin` 或自定义 `executeTool`。

同时，fixed prefix 不再使用 Chat 消息 id 游标作为边界。每次 loop 开始时记录项目时间函数产生的本地 wall-clock ISO 时间，fixed prefix 模式下的 Chat poll 使用这个时间作为 `range/from` 起点。

## 变更内容

- `llm-tool-loop` 新增工具注册表，统一通过注册的 `ToolPlugin.execute` 执行 tool call。
- Chat loop 和 Talk loop 不再接收 Agent 注入的 `executeTool`，改为传入：
  - tool registry 名称
  - tool call 来源
  - tool execution context 构造函数
  - tool input 转换函数
  - tool result 后置处理函数
- API capabilities runtime 注册默认 tool registry：`default`。
- 移除已过时字段和状态：
  - `sentMessage`
  - `onLLMSessionCompleted({ sentMessage })`
  - `llmSessionBusy`
  - `messageCursorId`
- 移除 fixed prefix 的消息 id 游标链路：
  - `fixedPrefixCursorMessageId`
  - `lastCheckChatCursorMessageId`
  - `__fromPrefixAfterMessageId`
  - `from_prefix`
- LLM session 新增并持久化：
  - `loopStartedAt`
  - `fixedPrefixStartedAt`
- fixed prefix 模式下的 Chat poll 改为 `scope: "range"` 和 `from: fixedPrefixStartedAt`。
- `prepare()` 开头先用项目时间函数写入当前 loop 的 `loopStartedAt`，保证 prepare 阶段内触发 fixed prefix control 时也能拿到本轮开始时间。
- Memory induction 路径改为使用 LLM tool loop 注册表执行工具，保持与 Chat/Talk 同一执行模型。

## 兼容性

- 不保留旧 message-id cursor fallback。
- 不保留 `from_prefix` / `__fromPrefixAfterMessageId` fallback。
- fixed prefix 继续存在，但边界语义从“某条消息 id 之后”改为“本次 loop 开始时间之后”。
- 时间戳使用项目时间提供器产生的本地 wall-clock ISO 字符串，不使用 `new Date().toISOString()` 作为 Agent 记录时间。

## 验证

已执行：

```bash
git diff --check
npm run typecheck
npm test
```

结果：

- `git diff --check` 通过。
- TypeScript 类型检查通过。
- 完整测试通过。
