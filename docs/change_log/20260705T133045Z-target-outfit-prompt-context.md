# on-body targetOutfit prompt 变量修复

日期：2026-07-05

## 背景

photo on-body 生成既可以由自动换装触发，也可以由管理后台对指定 outfit 手动触发。重构到统一 `PromptContextRuntime` 后，on-body prompt 继续使用 `{{outfit/...}}` 时会读取当前 daily shell outfit，而不是本次生成请求里的目标 outfit。

这会导致手动生成或非当前 outfit 生成时，prompt 中的服装描述可能与引用图目标不一致。

## 变更内容

- 在 `PromptContextRuntime` 中新增可选渲染参数 `targetOutfit`。
- 新增 prompt 变量族：
  - `{{targetOutfit/id}}`
  - `{{targetOutfit/name}}`
  - `{{targetOutfit/content}}`
  - `{{targetOutfit/group}}`
  - `{{targetOutfit/imageUrl}}`
  - `{{targetOutfit/onBodyImageUrl}}`
  - `{{targetOutfit/outfitImageGenerated}}`
  - `{{targetOutfit/onBodyGenerationAttempted}}`
- `{{outfit/...}}` 继续表示当前 daily shell outfit，不再被 on-body 生成目标覆盖。
- on-body 生成在渲染 `onBodyPrompt` 时传入本次解析出的目标 outfit，prompt 应使用 `{{targetOutfit/content}}` 等变量读取目标 outfit。
- 管理后台 photo on-body 测试样例改为使用 `{{targetOutfit/content}}`。

## 兼容性

- 不做 `{{outfit/...}}` 到 `{{targetOutfit/...}}` 的运行时自动替换。
- 不为 `targetOutfit` 设置 fallback；未传目标 outfit 时，`{{targetOutfit/...}}` 会保持未渲染。
- 不新增隐藏 prompt 文本，不改变 prompt layer 顺序。
- 本地运行配置 `config/plugin/photo/config.json` 含密钥，不纳入提交；如其中 `onBodyPrompt` 仍使用 `{{outfit/content}}`，需要改为 `{{targetOutfit/content}}`。

## 验证

已执行：

```bash
npm run typecheck
node --import tsx --test --test-concurrency=1 tests/contexts/agent-profile/text-renderer-render-variable.test.ts tests/apps/api/routes/admin/admin-routes-photo.test.ts tests/capabilities/tools/photo/photo-tools.test.ts
```

结果：

- TypeScript 类型检查通过。
- 相关 25 个测试全部通过。
- 额外本地 harness 验证：当前 daily outfit 与 on-body 目标 outfit 不同时，`{{outfit/content}}` 仍读取当前 outfit，`{{targetOutfit/content}}` 读取本次目标 outfit。
