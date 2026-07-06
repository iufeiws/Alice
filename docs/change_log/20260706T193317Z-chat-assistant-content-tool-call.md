# Chat assistant content 转 Chat tool call

## 背景

ChatAgent 需要把模型直接输出在 assistant `content` 中的文本，统一纳入 function-call loop 的工具执行链路。目标是让文本发送也表现为普通 tool call：先由 loop 生成 `Chat` 工具调用，再通过既有 `ToolPlugin.execute` 路径执行，而不是在 Chat loop 外部单独拦截或直接发送。

## 变更

- `llm-tool-loop` 新增 `transformAssistantMessage` hook，允许调用方在工具执行前改写 assistant message。
- `transformAssistantMessage` 支持返回 `completeAfterToolCalls`，用于纯 assistant content 被改造成工具调用并执行后直接完成本轮 loop。
- Chat loop 新增 `assistantContentToolCall` 配置项，用于声明：
  - 目标工具名。
  - 固定工具参数。
  - 将 assistant content 写入哪个参数字段。
- ChatAgent 配置 `assistantContentToolCall` 为 `Chat` 工具的 `send message` 调用。
- 当模型返回非空 assistant `content` 时，Chat loop 会把该内容清空，并插入第一顺位 `Chat` tool call；原本已有的其他 tool call 会保持顺序排在其后。
- 移除旧的 assistant content 直接执行 Chat 工具路径，以及旧的 `<chat>` 标签解析路径。

## 行为

模型输出：

```json
{
  "content": "xxxx",
  "toolCalls": ["function1"]
}
```

会在 loop 内改写为：

```json
{
  "content": "",
  "toolCalls": ["Chat.send(xxxx)", "function1"]
}
```

## 兼容性

- 不保留旧 `<chat>` 标签解析 fallback。
- 不在 loop 执行期按 tool name、requester 或 channel 特殊拦截工具执行。
- `Chat` 工具是否可用仍由 LLM request 构筑阶段暴露的 `toolNames` 决定。
- 本次未修改 prompt、prompt layer、prompt preview 或 LLM request 的 prompt 内容。

## 验证

已执行：

```bash
npm run typecheck
node --import tsx --test tests/contexts/agent-loop/*.test.ts
npm test
```

结果：

- TypeScript 类型检查通过。
- Agent loop 相关测试通过。
- 完整测试通过。
