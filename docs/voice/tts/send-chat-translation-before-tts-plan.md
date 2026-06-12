# TTS Plugin And Send Chat Voice

本文档替代旧的 Japanese Voice / jpvoice 方案说明。当前 canonical plugin 是 `tts`，显示名是 `TTS`。

## 当前目标

`plugins/tts` 负责出站语音合成相关逻辑：

- `send_chat` 的 `voice` 输出。
- TTS 前翻译。
- Genie-TTS / MOSS synthesizer 创建。
- Genie stream / file synthesis。
- Genie per-request override，包括语言、模型目录、参考音频、参考文本、语速、分段设置。
- WebRTC voice 复用的 `tts.voiceSynthesizer`。

`tools/messaging` 不拥有 TTS 实现，只调用注入的 `VoiceSynthesizer`。

## Canonical Names

| 项目 | 当前值 |
| --- | --- |
| Plugin id | `tts` |
| Admin id | `tts` |
| Display name | `TTS` |
| Config path | `config/plugin/tts/config.json` |
| Asset root | `assets/tts/preset/` |
| Legacy config fallback | `plugins/japanese-voice/config.json` |
| Legacy plugin path | `plugins/japanese-voice` compatibility only |

## Runtime Flow

```text
send_chat(type=voice, text)
  -> messaging tools preserve original transcript
  -> injected tts.voiceSynthesizer
  -> read config/plugin/tts/config.json
  -> optionally render translation prompt variables
  -> optionally translate text through apiPresetName
  -> synthesize translated text through Genie/MOSS
  -> return audio asset to messaging sender
```

Important boundaries:

- Translation prompt variables are rendered only for the translation prompt.
- The outgoing voice text, persisted transcript, reference text, and model path are not prompt-rendered.
- The original `send_chat` content remains persisted and returned.
- Translation output is transient and should not be written to message log.

## Config Shape

Current desired config shape:

```json
{
  "enabled": true,
  "remote": {
    "enabled": true,
    "baseURL": "http://192.168.0.103:8767"
  },
  "translationPresetName": "default",
  "translationPresets": {
    "default": {
      "translationEnabled": true,
      "apiPresetName": "voice",
      "prompt": "Translate for TTS: {{text}}"
    }
  },
  "voice": {
    "modelConfigName": "jp",
    "modelConfigs": {
      "jp": {
        "language": "jp",
        "speed": 1.15,
        "partSilenceSeconds": 0.25,
        "splitText": false
      }
    }
  }
}
```

`translationPresets` 是翻译预设集合。`voice.modelConfigs` 是模型预设集合。运行时使用哪个 preset 由公共设置保存：

- `translationPresetName` 指向 active translation preset。
- `voice.modelConfigName` 指向 active model preset。
- `remote.enabled` 控制是否优先请求远端 Genie TTS。
- `remote.baseURL` 保存远端 Genie TTS IP 或 base URL；只填 IP/host 时默认使用 `http://{host}:8767`。

编辑界面另有 edit target：

- `translationEditPresetName` 指向正在编辑的翻译 preset。
- `voice.modelEditPresetName` 指向正在编辑的模型 preset。

edit target 下拉切换只改变当前编辑对象，不改变 active preset，也不应该触发保存。

## Model Config Semantics

每个模型配置包含：

| 字段 | 含义 | Canonical 位置 |
| --- | --- | --- |
| `language` | Genie language override: `jp` / `zh` / `en` | config JSON |
| `speed` | Genie speed override | config JSON |
| `partSilenceSeconds` | split parts silence override | config JSON |
| `splitText` | Genie split text override | config JSON |
| model files | Genie model directory | `assets/tts/preset/{配置名}/model` |
| reference audio | 参考音频 | `assets/tts/preset/{配置名}/reference.*` |
| reference text | 参考文本文件 | `assets/tts/preset/{配置名}/reference.txt` |

修改配置名或新建配置后，相关资产应该归一到：

```text
assets/tts/preset/{配置名}/model/
assets/tts/preset/{配置名}/reference.*
assets/tts/preset/{配置名}/reference.txt
```

`modelDir`、`referenceAudio`、`referenceText` 不再保存到 config；路径由模型预设名直接推导。旧路径可以保留作为迁移来源，但新写入不应该再写到 `assets/plugin/japanese-voice/`、`assets/plugin/tts/` 或 `assets/tts/model/`。

## 当前 Plugin 设置布局

当前 admin 页面不是 `翻译 | 模型 | 公共` 三个 tab。页面应纵向展示三个块：翻译、模型、公共。

- 翻译块：标题行展示翻译开关；下面展示编辑目标 preset select 和 `Modify` 按钮；点击 `Modify` 后才展开 preset 详情。
- 模型块：展示编辑目标 preset select 和 `Modify` 按钮；点击 `Modify` 后才展开模型 preset 详情。
- 公共块：直接展示公共字段，包括运行时 active translation/model preset。
- 每个块单独保存：`Save Translation Preset` 保存编辑目标翻译 preset，`Save Model Preset` 保存编辑目标模型 preset，`Save Common Settings` 保存 active preset 选择和公共字段。
- TTS 页面不提供全局 Save，避免一次保存误写多个 preset。

| Group | Key | Label | Type | 备注 |
| --- | --- | --- | --- | --- |
| `translation` | `translationEditPresetName` | `Translation Preset` | select | 编辑目标，从 `translationPresets` 动态生成选项，不改变 active preset |
| `translation` | `currentTranslation.translationEnabled` | `Translate Text` | switch | 常驻显示，是否 TTS 前翻译 |
| `translation` | `newTranslationPresetName` | `Create or Rename` | text | Modify 后显示，输入后保存会创建或切换翻译预设 |
| `translation` | `currentTranslation.apiPresetName` | `API Preset` | apiPresetSelect | Modify 后显示，翻译使用的 LLM preset |
| `translation` | `currentTranslation.prompt` | `Prompt` | textarea | Modify 后显示，翻译 prompt，支持 prompt variables |
| `model` | `voice.modelEditPresetName` | `Model Preset` | select | 编辑目标，从 `voice.modelConfigs` 动态生成选项，不改变 active preset |
| `model` | `voice.newModelConfigName` | `Create or Rename` | text | Modify 后显示，输入后保存会创建或切换配置 |
| `model` | `voice.currentModel.language` | `Voice Language` | select | Modify 后显示，`jp` / `zh` / `en` |
| `model` | `voice.currentModel.modelDir` | `Model Folder` | folderUpload | Modify 后显示，assetKey: `model` |
| `model` | `voice.currentModel.referenceAudio` | `Reference Audio` | fileUpload | Modify 后显示，assetKey: `reference-audio` |
| `model` | `voice.currentModel.referenceText` | `Reference Text` | textarea | Modify 后显示，UI 展示文本内容，配置保存文件路径 |
| `model` | `voice.currentModel.speed` | `Voice Speed` | number | Modify 后显示，`0.5` 到 `2.0` |
| `model` | `voice.currentModel.splitText` | `Split Text` | switch | Modify 后显示，默认 `false` |
| `model` | `voice.currentModel.partSilenceSeconds` | `Part Silence` | number | Modify 后显示，`0` 到 `3` |
| `general` | `translationPresetName` | `Active Translation Preset` | select | 运行时使用的翻译 preset |
| `general` | `voice.modelConfigName` | `Active Model Preset` | select | 运行时使用的模型 preset |
| `general` | `enabled` | `Enabled` | switch | 开关 TTS plugin |
| `general` | `remote.enabled` | `Remote Genie` | switch | 是否优先使用远端 Genie TTS |
| `general` | `remote.baseURL` | `Remote Genie IP/URL` | text | 远端 Genie TTS IP 或 base URL，例如 `192.168.0.103` 或 `http://192.168.0.103:8767` |
| `general` | `targetRoute` | `Target Route` | readonly | `send_chat.voice.before_tts` |
| `general` | `persistTranslation` | `Persist Translation` | readonly | 翻译不持久化 |

当前行为细节：

- `translationEditPresetName` 是翻译块的编辑目标；保存翻译块时写入 `translationPresets[translationEditPresetName]`，不改变 `translationPresetName`。
- `newTranslationPresetName` 保存时创建或切换编辑目标，但不改变 active preset。
- `currentTranslation.*` 是 admin 展示层字段。
- `voice.modelEditPresetName` 是模型块的编辑目标；保存模型块时写入 `voice.modelConfigs[voice.modelEditPresetName]`，不改变 `voice.modelConfigName`。
- `voice.newModelConfigName` 保存时创建或切换编辑目标，但不改变 active preset。
- `voice.currentModel.*` 是 admin 展示层字段。
- `voice.currentModel.referenceText` 在 admin payload 中展开为文本内容；保存后写入 `assets/tts/preset/{preset}/reference.txt`，config 不保存路径。
- 真实 `config/plugin/tts/config.json` 不写入 admin-only 字段：`translationEditPresetName`、`currentTranslation`、`newTranslationPresetName`、`voice.modelEditPresetName`、`voice.currentModel`、`voice.newModelConfigName`。
- 模型上传当前会扁平化写入 `assets/tts/preset/{配置名}/model/{fileName}`，不保留上传时的相对目录。

保存边界：

- 保存翻译块时，PATCH body 应包含 `translationEditPresetName` 和 `currentTranslation.*`，写入 `translationPresets[translationEditPresetName]`。
- 保存模型块时，PATCH body 应包含 `voice.modelEditPresetName` 和 `voice.currentModel.*`，写入 `voice.modelConfigs[voice.modelEditPresetName]`。
- 保存公共块时，PATCH body 才包含 `translationPresetName`、`voice.modelConfigName` 和 `remote.*`，用于改变运行时 active preset 和远端服务设置。
- 如果用户只是在翻译或模型块里切换下拉查看/编辑其他 preset，不能把该下拉值保存为 active preset，否则会把“编辑目标”误当成“运行时选择”。

## Remote Genie Request Flow

远端请求流程必须对齐 `docs/remote_server/genie_tts/CLIENT_UPLOAD_FLOW.md`：

```text
TTS text
  -> POST /synthesize
     content-type: application/json
     body: {"text":"...", "language":"...", "modelDir":"...", "referenceText":"显式参考文本", "splitText":false}
  -> 如果正常返回，把 response WAV bytes 写入本地生成文件，再走 loudness / opus 转换
  -> 如果返回 409 MODEL_NOT_UPLOADED 或 REFERENCE_NOT_UPLOADED:
       zip preset dir that contains local_model_dir, reference audio, and reference text
       POST returned uploadUrl as application/zip
       如果没有 uploadUrl, POST /models/upload?modelDir={local_model_dir}
       retry original /synthesize request unchanged
```

约束：

- `modelDir` 必须是原始请求里的同一个本地路径，不换成 model id。
- `referenceText` 必须是显式文本内容，不能传 `reference.txt` 路径。
- zip 内容来自 `assets/tts/preset/{模型配置名}/`，需要包含该 preset 的 `model/`、`reference.*` 和 `reference.txt`。
- 上传成功后重试原请求，不改变 `language`、`modelDir`、`splitText` 或文本。
- 远端请求在产出音频前失败时可以 fallback 到 local Genie。
- local Genie 继续使用本地 `/stream` JSON 请求路径；显式远端文件合成使用 `/synthesize`，远端流式接口仍保留给真正需要 PCM stream 的调用。

## Migration Rules

兼容读取：

- 优先读 `config/plugin/tts/config.json`。
- 如果新 config 不存在，可以读 `plugins/japanese-voice/config.json`。
- 旧 flat 字段仍可作为迁移输入：
  - `voice.language`
  - `voice.modelDir`
  - `voice.referenceAudio`
  - `voice.referenceText`

新写入：

- 只写 `config/plugin/tts/config.json`。
- 使用 `translationPresets` 和 `voice.modelConfigs`。
- 模型资产写到 `assets/tts/preset/{配置名}/`。

## WebRTC Usage

`webrtc_voice` 不直接实现 TTS，也不复制 TTS voice 参数。它应该复用：

```text
tts.voiceSynthesizer
```

TTS plugin 内部决定是否翻译、使用哪个模型配置、如何调用 Genie/MOSS，以及如何处理 streaming/fallback。
