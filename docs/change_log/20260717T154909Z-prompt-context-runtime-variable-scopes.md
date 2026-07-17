# Prompt context 运行时变量作用域与网关严格解析

日期：2026-07-18

## 背景

`PromptContextRuntime` 原本只解析应用级全局变量。Photo 工具的 `pose` 等当前运行参数无法通过统一 runtime 注入，未解析的 `{{pose}}` 会被原样发送到图片生成网关。Memory 同时维护了两套私有变量 renderer，导致解析语义分叉。

## 变更内容

- `PromptContextRuntime` 新增不可变 `withVariables()` 作用域：子作用域覆盖父作用域，不修改应用级 runtime，并使用变量是否存在的语义避免 `null` 意外回退。
- 未解析的 `{{name}}` 不再原样保留，而是由统一 runtime 直接抛错。
- Photo 在当前工具作用域注入 `pose`；服装上身图生成改用展平的 `targetOutfit/*` 作用域变量。
- Memory 删除私有 `{{}}` 替换器，Memorize 变量和 workspace 路径统一使用 `withVariables()`。
- LLM tool JSON Schema 会递归解析嵌套 `title`/`description`，不再漏掉 `properties.*.description`。
- ASR 和 image-recognition 删除缺少 prompt runtime 时的原文 fallback；Admin ASR 和 File/Read 图片识别路径补齐统一 runtime 装配。

## 兼容性

- 不保留 `PromptContextRenderOptions.targetOutfit` 兼容入口。
- 缺少 runtime 或存在未解析变量时明确失败，不做静默降级。
- 不新增任何 prompt 文本，不改变 prompt layer 顺序。

## 测试

- 新增 runtime 作用域隔离、覆盖、`null` shadow 和未解析报错测试。
- 新增 LLM、TTS、Photo、ASR 和 image-recognition 跨网关 prompt 解析契约测试。
- 恢复 Photo executor prompt 中 `pose` 已解析且无 `{{name}}` 残留的回归断言。

## 验证

已执行：

```bash
npm run typecheck
node --import tsx --test --test-concurrency=1 tests/contexts/agent-profile/prompt-context-gateways.test.ts
node --import tsx --test --test-concurrency=1 tests/capabilities/tools/photo/photo-tools-selfie-core.test.ts
node --import tsx --test --test-concurrency=1 tests/capabilities/tools/file/file-tools.test.ts
node --import tsx --test --test-concurrency=1 tests/apps/api/routes/admin/admin-routes-asr.test.ts
```

上述类型检查和定向测试全部通过。
