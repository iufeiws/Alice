# TTS 插件

`src/channels/tts` 是出站语音合成插件的实现位置。

它负责 TTS 前翻译、Genie/MOSS 合成器创建、流式音频事件，以及 `send_chat` 语音输出和 WebRTC 语音播放使用的配置。`tools/messaging` 只应依赖注入进来的 `VoiceSynthesizer`。

## 运行边界

- Plugin id：`tts`
- Admin id：`tts`
- Display name：`TTS`
- 主配置路径：`config/plugin/tts/config.json`
- 预设配置路径：`config/plugin/tts/presets/{preset}.json`
- 资源根目录：`assets/tts/preset/`

`send_chat` 的原始出站文本仍然是会话 transcript 和持久化消息内容。翻译结果只用于语音合成，不写回消息历史。

## 配置结构

主配置只保存全局开关、运行时选中的 TTS 预设、当前编辑的 TTS 预设，以及翻译预设：

```json
{
  "enabled": true,
  "activePresetName": "mimo",
  "editPresetName": "mimo",
  "translationPresetName": "default",
  "translationPresets": {
    "default": {
      "translationEnabled": true,
      "apiPresetName": "voice"
    }
  }
}
```

每个 TTS 预设是独立的扁平 JSON 文件，位于 `config/plugin/tts/presets/`。预设名必须能安全作为文件名使用。

示例：

```json
{
  "provider": "genie",
  "genie": {
    "enabled": true,
    "baseURL": "http://127.0.0.1:8767",
    "localFallbackEnabled": false,
    "language": "jp",
    "modelDir": "assets/tts/preset/genie-jp/model",
    "speed": 1.15,
    "partSilenceSeconds": 0.25,
    "splitText": false
  }
}
```

`provider` 决定该预设使用的后台，可以是 `genie`、`openai-api`、`bailian` 或 `mimo`。运行时只使用 `activePresetName` 指向的预设。

## Genie 资源

Genie 预设只保存运行所需的模型指针和参数。引用音频和引用文本不保存在预设 JSON 中，路径由预设名推导：

```text
assets/tts/preset/{preset}/model/
assets/tts/preset/{preset}/reference.*
assets/tts/preset/{preset}/reference.txt
```

上传模型时，管理后台写入当前编辑预设的 `genie.modelDir`。上传引用音频和保存引用文本时，管理后台写入同一个预设资源目录。

## 后台预设

- `mimo`：MiMo TTS 预设，保存 MiMo 模式、鉴权、音色、voice clone 数据等配置。
- `bailian`：百炼 TTS 预设，保存 service、endpoint、workspace、voice、format、采样率等配置。
- `openai-api`：OpenAI 兼容 speech API 预设，保存 API preset、model、voice、format、采样率等配置。
- `genie-*`：Genie 预设，通常每个旧 Genie model 生成一个同名派生预设，例如 `genie-jp`。

旧的 `config/plugin/tts/providers/*.json` 不再是运行时配置来源。

## 管理后台行为

TTS 预设有两个独立选择：

- `activePresetName`：运行时使用的预设。
- `editPresetName`：管理后台当前编辑的预设。

保存编辑预设不会自动切换运行时预设。只有修改 `activePresetName` 才会改变运行时使用的后台和配置。

管理后台 payload 可以包含 `currentPreset` 和 `newPresetName`。这些是表单编辑字段，不写入主配置文件；真正的预设内容写入对应的 `presets/{preset}.json`。

## Remote Genie 流程

当活动预设的 `provider` 是 `genie` 且 `genie.enabled` 为 true 时，运行时先尝试 `genie.baseURL` 指向的远端 Genie 服务。如果远端在产出音频前失败，只有在 `genie.localFallbackEnabled` 为 true 时才允许启动本地 Genie。

显式远端 Genie 请求使用 `docs/remote_server/genie_tts/CLIENT_UPLOAD_FLOW.md` 记录的上传协议：

1. 向 `/synthesize` 发送 JSON 合成请求，不为显式远端请求发送 `outputPath`。
2. `modelDir` 保持为当前预设的本地模型目录路径。
3. `referenceText` 作为文本内容放入 JSON 请求体，不发送 `reference.txt` 路径。
4. 如果服务端返回 `409` 且 `code` 是 `MODEL_NOT_UPLOADED` 或 `REFERENCE_NOT_UPLOADED`，则打包包含 `modelDir` 与同目录引用资源的预设目录，并按返回的 `uploadUrl` 上传。
5. 上传成功后，使用原始请求重试 `/synthesize`。

本地 Genie 仍使用本地 `/stream` JSON 请求路径，但 `referenceText` 同样会先解析为文本内容。
