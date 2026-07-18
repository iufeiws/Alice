# Prompt Layer 统一为消息协议

日期：2026-07-18

## 背景

Prompt Profile、Memorize 和 Initiated Behaviors 原先分别维护自定义 layer 字段、排序字段和工具调用结构，与实际 LLM message 协议不一致，也让管理页存在多套编辑逻辑。

## 变更内容

- Prompt Layer 统一存储为 `{ meta, messages }`；消息直接使用现有 `LLMMessage` 字段，并仅在 `message.meta` 中保存 `title` 和 `enabled` 编辑信息。
- Prompt Profile 的 `layers`、`appendLayers` 和 `interruptLayer` 分别保存独立 Layer 文档；消息数组顺序即发送顺序，删除 `order`。
- Assistant 工具调用改为标准 `reasoningContent` 和 `toolCalls[].function` 结构，工具结果继续紧邻对应调用进入同一 LLM 消息序列。
- Prompt、Talk、Memorize 与 Initiated Behaviors 管理页共用同一个 LayerEdit 组件。
- Memorize 删除历史目标分类，使用单一 `{ meta, messages }` 文档处理全部记忆文件。
- Memorize 文件超限提示保持运行时内建错误协议，不进入 Prompt 存储和编辑器；原有 `user / Cheshire Cat / <Error>...</Error>` 消息及完整路径、行数、字节数动态详情继续追加到同一个 function-call loop。
- Initiated Behaviors 与 Random Events 统一为顶层 `{ meta, messages }`，事件权重、优先级和启用状态保存在事件 `meta` 中。
- 现有 Prompt、Talk、Memorize、Initiated Behaviors 和 Random Events JSON 已迁移到新协议。

## 兼容性

- 不保留旧 layer schema、分类字段或工具调用字段的 fallback。
- 不在运行时补充隐藏 Prompt，也不重新排序消息。
- Prompt Preview 继续使用与实际 LLM 请求相同的公共解析入口。

## 验证

已执行：

```bash
npm run typecheck
npm run build
node --import tsx --test tests/contexts/memory/memorize-prompt.test.ts tests/contexts/memory/sleep-memory-induction.test.ts tests/contexts/memory/sleep-memory-runtime.test.ts tests/contexts/memory/sleep-memory-workspace.test.ts tests/apps/api/admin-ui/admin-html-prompts.test.ts tests/apps/api/routes/admin/admin-routes-memory.test.ts
git diff --check
```

上述类型检查、构建、Prompt/Memory/Admin 定向测试和 diff 检查均通过。完整测试运行到既有 `tests/channels/image-recognition/image-recognition-plugin.test.ts` 时失败，其期望返回成功结果但当前运行时返回了错误结果；该文件及对应实现不在本次变更中。
