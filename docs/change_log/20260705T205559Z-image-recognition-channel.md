# Image Recognition channel

日期：2026-07-06

## 背景

需要新增一个图像识别 channel，用于把本地图片交给多模态 LLM 生成文字描述。实现需要参考现有 ASR 的 multimodal LLM 路径：

- 复用已有 LLM API preset，不新增一套 base URL、API key 或 model 配置。
- channel 自己维护 prompt。
- 支持独立 Extra Params JSON，用于本次识别请求，替换所选 preset 的 `extraParams`。

项目 prompt 约束要求运行时不能私自追加隐藏 prompt。因此本次只把默认 prompt 作为插件可编辑配置值保存，运行时实际发送的 prompt 来自插件配置。

## 变更内容

- 新增 `src/channels/image-recognition/src/index.ts`：
  - 提供 `recognizeImageWithPlugin`。
  - 读取图片文件、Blob 或 Uint8Array。
  - 构造 OpenAI-compatible chat completions 消息：
    - `image_url` data URL。
    - 插件配置里的 prompt text。
  - 通过统一 `LLMRequestSender` 发送请求。
  - 返回标准化图片描述文本。
- 新增 `src/contexts/capabilities/src/admin-plugin-image-recognition-runtime.ts`：
  - 在管理后台 Plugins 注册 `image-recognition`。
  - 配置字段包括：
    - `enabled`
    - `testImagePath`
    - `apiPresetName`
    - `prompt`
    - `extraParams`
  - 支持上传测试图片到 `assets/plugin/image-recognition/test-image/`。
  - 支持管理后台运行测试。
- 扩展通用 plugin config UI：
  - `testSchema.input` 支持 `image`。
  - image 测试向 `/admin/api/plugins/image-recognition/test` 传 `imageFile`。
- 扩展 plugin asset helper：
  - `test-image` 上传固定落到插件自己的 `test-image/` 子目录。

## 兼容性

- 不改 Core、Talk 或 Memorize prompt 构筑。
- 不改变 prompt layer 顺序。
- 不新增隐藏 prompt。
- 不自动接入 Feishu/WeChat 入站图片；当前只提供可配置、可测试的 channel/plugin。
- `extraParams` 使用 image-recognition 插件配置值，不合并 preset 的 `extraParams`。

## 验证

已执行：

```bash
npm run typecheck
node --import tsx --test tests/channels/asr/asr-plugin-multimodal.test.ts tests/channels/image-recognition/image-recognition-plugin.test.ts
node --import tsx --test tests/apps/api/admin-ui/admin-html-plugins.test.ts
npm test
```

结果：

- TypeScript 类型检查通过。
- ASR multimodal LLM 路径测试通过。
- Image Recognition channel 测试通过。
- 管理后台 plugin HTML 测试通过。
- 完整测试通过。
