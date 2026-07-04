# Runtime interrupt 与 Yield resume 边界调整

日期：2026-07-04

## 背景

运行中的 LLM loop 收到新用户消息时，需要在下一次可继续请求 LLM 的位置提示模型；但 `Yield` 是等待控制语义，不能通过 Alert 提醒替代原有 finish-and-wait resume。

同时，Anthropic tool-use 顺序要求 tool result 必须紧跟对应 tool use，不能把用户消息或提醒插到 tool use 和 tool result 中间。

## 变更内容

- `ChatAgent` 不再持有或消费 pending user-message interrupt flag。
- `AgentLoopRuntime` 继续拥有 pending interrupt 运行态，并在执行 prepared loop spec 时向 `runLLMToolLoop` 注入：
  - `hasPendingUserMessage()`
  - `consumePendingUserMessage()`
- `runLLMToolLoop` 在本轮 tool calls 完成并写回 assistant tool-use / tool results 后统一处理 interrupt：
  - 普通 tool continuation 且下一轮会继续请求 LLM：在所有 tool result 后追加 prompt profile 的 `interruptLayer`。
  - `Yield` 且存在 pending user message：不追加 Alert，调用 chat loop 提供的 `buildYieldResumeMessages`，复用原 `buildWaitChatResumeMessages` 补齐 Yield resume tool result，然后继续当前 tool loop。
  - `Yield` 且没有 pending user message：保持原 `yield_return` 返回路径。
- `interruptLayer` 从 prompt profile 渲染，不再作为 ChatAgent 专用 hook 参数传入。
- Talk loop 也传递 prompt profile，使普通 Alert 插入逻辑位于通用 LLM tool loop 边界。
- 管理页的 Interrupt Layer 编辑入口不再限制为 Chat profile 文案。

## 兼容性

- 不新增 Yield resume 调度路径。
- 不让 `ToolPlugin.execute` 消费 interrupt flag。
- 不把 Alert 插入到 assistant tool use 和 tool result 中间。
- `Yield` 的原 heartbeat resume 语义保留；运行中 pending user message 只是在同一 loop 内提前复用这条 resume 构造逻辑。
- loop 结束时未消费的 pending interrupt 仍由 runtime 清理，不会泄漏到下一轮。

## 验证

已执行：

```bash
npm run typecheck
git diff --check
node --import tsx --test --test-concurrency=1 tests/contexts/agent-loop/agent-loop-runtime.test.ts tests/contexts/agent-loop/agent-loop-runtime-chat-loop.test.ts tests/contexts/agent-loop/agent-tools-wait.test.ts tests/contexts/llm-gateway/llm-tool-loop.test.ts
python3 -B -m unittest tests/scripts/genie_tts/genie_tts_service_test.py
```

结果：

- TypeScript 类型检查通过。
- diff 空白检查通过。
- 相关 TypeScript 测试通过。
- Genie TTS Python 单测通过。

