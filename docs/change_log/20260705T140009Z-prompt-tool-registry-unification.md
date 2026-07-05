# Prompt tool registry 执行路径统一

日期：2026-07-05

## 背景

本次调整延续 `20260704T224611Z-llm-tool-loop-unification.md` 的 tool loop 统一目标。主 LLM tool call 已经由 `llm-tool-loop` registry 统一执行，但 Chat/Talk 的 prompt layer tool request 和 `finish_and_wait` resume 补 tool result 仍保留一套 Agent loop 本地 `toolMap` 执行器。

这会让同一类会写入 LLM transcript 的 tool request 存在两套查找和执行口径，也会让 append prompt tool request 在工具不可用时被静默过滤。

## 变更内容

- 删除 Agent loop 本地 tool map 执行器。
- `runPromptToolRequest` 改为通过 `executeRegisteredLLMTool` 调用已注册的 tool registry。
- Chat 初始 prompt tool request、initiated behavior prompt tool request、append prompt tool request 改走统一 registry。
- Talk 初始 prompt tool request 改走统一 registry，并继续维护 `lastCompletedToolName`。
- `finish_and_wait` resume 补 tool result 改走统一 registry。
- 移除 append prompt tool request 的本地可用性过滤；工具不可用时暴露 `llm_tool_unavailable:*`，不再静默丢弃 layer。
- 新增行为测试，覆盖 Chat/Talk 首轮 LLM request 中的 prompt tool result，以及 append tool 不可用时不会发送缺失 tool result 的 LLM request。

## 兼容性

- 不保留旧 `toolPlugins -> toolMap -> execute` fallback。
- 不保留 append tool request 静默过滤 fallback。
- 不修改 prompt 文本。
- 不修改 prompt layer 顺序。
- Tool 可用性仍由 request 构筑阶段的 visible tools / `toolNames` 决定；已进入 transcript 构筑的 tool request 必须通过统一 registry 执行或明确失败。

## 验证

已执行：

```bash
node --import tsx --test --test-concurrency=1 tests/contexts/agent-loop/agent-tools.test.ts tests/contexts/agent-loop/talk-agent-loop-tools.test.ts tests/contexts/agent-loop/agent-tools-wait.test.ts
npm run typecheck
npm test
git diff --check
```

结果：

- 相关 Agent loop 测试通过。
- TypeScript 类型检查通过。
- 完整测试通过。
- diff 空白检查通过。
