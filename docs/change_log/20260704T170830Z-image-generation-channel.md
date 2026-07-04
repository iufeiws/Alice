# 2026-07-05 image-generation channel 与 on-body 生成归属调整

## 背景

本次调整来自 photo 的 on-body 生成没有跟随 photo 后端设置的问题。排查后确认：

- `Selfie` 工具路径会按 `selfieMode` 选择 `openai`、`openaiRelay` 或 `codex`。
- on-body 生成路径原先在 `admin-plugin-runtime.ts` 内直接调用 OpenAI Image API 执行器。
- 因此当 photo 配置切到 `codex` 时，on-body 仍走 Image API 路径，且调用方直接接触了 provider 细节。

后续讨论明确了新的模块归属：

- 图片生成后端统一归 `channels/image-generation`。
- `onBodyPrompt`、`onBodyReferenceImage`、`selfieOnBodyPrompt` 等配置字段保持当前配置位置和字段名不变，但由 image-generation 相关模块读取和解释。
- on-body 的业务调用定义属于 outfit 相关运行时，不属于通用 admin plugin runtime。

## 变更内容

### 新增 `channels/image-generation`

新增目录：`src/channels/image-generation/src/`

该 channel 现在持有图片生成的统一实现：

- `config.ts`
  - 迁入 photo/image generation 配置读取、默认值归一化、public config 脱敏逻辑。
  - 保持现有配置路径 `config/plugin/photo/config.json` 和字段名不变。
- `gateway.ts`
  - 提供统一入口 `runPhotoGateway`。
  - 调用方只传生成 prompt、引用图路径、输出文件基名、可选 provider。
  - 内部负责 `selfieMode` 到 provider 的选择、并发控制、服务商参数展开。
  - `codex` 路径会继续传入现有 `selfieCodexExtraPrompt`。
- `openai-api-provider.ts`
  - 迁入 `openai` / `openaiRelay` provider。
- `codex-provider.ts`
  - 迁入 `codex` provider。
- `image-files.ts`
  - 迁入生成图校验、JPEG 归一化、mime 检测。
  - 错误文本改为 image-generation channel 自有文案，避免反向依赖 photo tool。
- `process-exec.ts`
  - 迁入子进程执行 helper。

### 精简 `capabilities/tools/photo`

`photo` tool 不再持有 provider/gateway/image 文件实现。

删除旧实现文件：

- `src/capabilities/tools/photo/src/codex-selfie.ts`
- `src/capabilities/tools/photo/src/openai-api-selfie.ts`
- `src/capabilities/tools/photo/src/photo-provider.ts`
- `src/capabilities/tools/photo/src/image-files.ts`
- `src/capabilities/tools/photo/src/process-exec.ts`

保留：

- `selfie-tool.ts`
  - 继续负责 Selfie tool 的参数、目标解析、自拍 prompt 渲染、引用图收集和发送结果。
  - 生成动作改为调用 `channels/image-generation` 的 `runPhotoGateway`。
- `config.ts`
  - 作为兼容 re-export，避免现有 import 同时大面积改动。

### 移动 on-body 业务实现

on-body 生成实现从 `src/contexts/capabilities/src/admin-plugin-runtime.ts` 移到：

- `src/contexts/capabilities/src/outfit-on-body-runtime.ts`

调整后：

- `admin-plugin-runtime.ts` 只保留 `/admin/api/plugins/photo/on-body` 的 HTTP 适配：读取 JSON body、调用 outfit runtime、写 JSON response。
- `outfit-on-body-runtime.ts` 负责：
  - 读取 image-generation/photo 配置。
  - 校验 on-body prompt 和 reference image。
  - 根据 outfit 信息渲染 on-body prompt。
  - 调用 image-generation gateway。
  - 写回 outfit 的 `onBodyImageUrl` 与 `onBodyGenerationAttempted` 状态。
  - 保持失败时首次尝试清理、已有 on-body 图保留状态等原有行为。

## 兼容性

- 配置文件路径未改：`config/plugin/photo/config.json`。
- 配置字段名未改：
  - `selfieMode`
  - `selfieCodexCommand`
  - `selfieCodexExtraPrompt`
  - `selfieCodexTimeoutMs`
  - `selfieImageApi*`
  - `selfieImageApiRelay*`
  - `autoGenerateOutfitOnBody`
  - `onBodyReferenceImage`
  - `onBodyPrompt`
  - `selfieOnBodyPrompt`
  - `selfie2DinReal*`
- 管理后台 photo config schema 未迁移字段，用户现有配置继续生效。
- `capabilities/tools/photo/src/config.ts` 暂保留为兼容导出。

## 验证

已执行：

```bash
npm run typecheck
node --import tsx --test --test-concurrency=1 tests/capabilities/tools/photo/photo-tools.test.ts tests/capabilities/tools/photo/photo-tools-selfie-core.test.ts tests/capabilities/tools/photo/photo-tools-selfie-api.test.ts tests/apps/api/routes/admin/admin-routes-photo.test.ts tests/capabilities/tools/shell/shell-tools-store.test.ts
```

结果：

- TypeScript 类型检查通过。
- 相关 26 个测试全部通过。

## 备注

- 本次没有迁移 prompt 字段内容，也没有新增隐藏 prompt。
- `onBodyPrompt` 等配置保持原位置不变，只调整模块所有权和调用路径。
- 工作区中的 `src/contexts/agent-profile/prompts/prompt-profile.json` 是本次提交外的既有修改，未纳入本次变更。
