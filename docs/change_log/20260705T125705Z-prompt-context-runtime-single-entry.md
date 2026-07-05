# Prompt context runtime 单一入口重构

日期：2026-07-05

## 背景

本次调整来自 `docs/plan/2026-07-05_prompt-context-runtime-single-entry-plan.md`。目标是把 prompt 变量树、文本渲染和 LLM request 构筑中的 prompt context 处理收敛到单一运行时入口，避免各路径各自拼变量对象或复制渲染逻辑。

同时，运行时不得私自追加隐藏 prompt；Prompt Preview 与实际发送给 LLM 的消息序列应保持一致。

## 变更内容

- 新增 `contexts/prompt-context` 模块，提供 `PromptContextRuntime`、`PromptContextValue`、变量树构造和 `createPromptContextRuntime`。
- 移除旧的 `LLMTextRenderer`、`LLMTextValue`、`LLMTextVariables` 和 bootstrap 侧 prompt context runtime。
- LLM request 构筑、tool loop、Agent loop、Memory runtime、ASR/TTS 和工具能力改为显式接收并传递同一个 prompt context runtime。
- LLM tool result 的字符串渲染集中在 `llm-tool-loop`，对象和数组保持 JSON 序列化，不再在各工具或 Agent loop 中分散格式化。
- `extraParams` 不再走 prompt 渲染；仅 tool description 和 JSON schema 的 title/description 使用 prompt context runtime 渲染。
- Photo、Bookcase、Messaging、Memory、ASR、TTS 等测试改为使用统一测试 helper 创建 prompt context runtime。
- 新增 `docs/todoNote.md`，记录 skill args 无占位符时不应自动追加到末尾的待办项。

## 兼容性

- 不保留旧 `LLMTextRenderer` API fallback。
- 不保留变量对象与 prompt context runtime 并存的兼容路径。
- 不新增任何隐藏 prompt 拼接。
- 传入 `toolVariables` 但缺少 prompt context runtime 时直接报错，不静默降级。

## 验证

已执行：

```bash
npm run typecheck
node --import tsx --test --test-concurrency=1 tests/capabilities/tools/photo/photo-tools-selfie-core.test.ts
node --import tsx --test --test-concurrency=1 tests/channels/asr/asr-plugin-multimodal.test.ts
node --import tsx --test --test-concurrency=1 tests/contexts/agent-loop/agent-loop-runtime.test.ts
node --import tsx --test --test-concurrency=1 tests/contexts/llm-gateway/llm-tool-loop.test.ts
node --import tsx --test --test-concurrency=1 tests/apps/api/routes/admin/admin-routes-photo.test.ts
```

结果：

- TypeScript 类型检查通过。
- 相关 TypeScript 测试通过。
