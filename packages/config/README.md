# Config 说明

`packages/config` 从环境变量加载运行时配置。

## 公共 API

```ts
loadConfig(env = process.env): AppConfig
```

## LLM 配置

环境变量：

- `LLM_PROVIDER`
- `LLM_BASE_URL`
- `LLM_API_KEY`
- `LLM_MODEL`
- `LLM_TEMPERATURE`
- `LLM_TIMEOUT_MS`
- `LLM_STREAM_ENABLED`
- `LLM_EXTRA_PARAMS`
- `LLM_FOLLOWUP_EXTRA_PARAMS`

如果同时存在 `LLM_BASE_URL` 和 `LLM_API_KEY`，provider 会变为 `openai-compatible`；否则 API 进程使用 stub LLM client。
`LLM_PROVIDER` 当前只作为管理配置字段保留，实际 provider 由 base URL 与 API key 是否同时存在决定。
`LLM_FOLLOWUP_EXTRA_PARAMS` 未设置时会沿用 `LLM_EXTRA_PARAMS`。

## Core/API 配置

环境变量：

- `API_HOST`
- `API_PORT`
- `AGENT_TIMEZONE`
- `AGENT_INBOUND_DEBOUNCE_MS`
- `AGENT_DEFAULT_TARGET_PLUGIN`

`AGENT_DEFAULT_TARGET_PLUGIN` 只接受 `auto`、`wechat` 或 `feishu`；其他值会回落为 `auto`。

## 飞书配置

环境变量：

- `FEISHU_ENABLED`
- `FEISHU_CONNECTION_MODE`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_REQUIRE_MENTION`
- `FEISHU_PAIRING_COMMAND`

默认策略偏保守：

- DM 策略：`pairing`
- 群聊策略：`allowlist`
- 群聊默认要求 mention
- Codex 命令策略：要求 allowlist 与显式命令

`FEISHU_PAIRING_COMMAND` 由飞书 pairing 模块直接读取，默认 `/pair alice`。

## 微信 iLink 配置

环境变量：

- `WECHAT_ENABLED`
- `WECHAT_ILINK_BOT_TOKEN`
- `WECHAT_ILINK_BASE_URL`
- `WECHAT_ILINK_POLL_TIMEOUT_MS`

扫码登录成功后，后台会把 `WECHAT_ENABLED=true` 和账号专属 `WECHAT_ILINK_BASE_URL` 写回 `.env`，并把完整登录态保存到 `memory-files/indexes/wechat-ilink-state.json`。

## 媒体配置

自拍图片生成使用 OpenAI Image API 兼容配置：

- `OPENAI_API_KEY`
- `SELFIE_IMAGE_API_KEY`
- `SELFIE_IMAGE_API_BASE_URL`
- `SELFIE_IMAGE_API_MODEL`
- `SELFIE_IMAGE_API_SIZE`
- `SELFIE_IMAGE_API_QUALITY`
- `SELFIE_IMAGE_API_OUTPUT_FORMAT`
- `SELFIE_IMAGE_API_OUTPUT_COMPRESSION`
- `SELFIE_IMAGE_API_TIMEOUT_MS`
- `SELFIE_REFERENCE_DIR`
- `SELFIE_OUTPUT_DIR`
- `SELFIE_CODEX_COMMAND`
- `SELFIE_CODEX_TIMEOUT_MS`
- `SELFIE_MAX_BYTES`

`SELFIE_IMAGE_API_KEY` 会覆盖 `OPENAI_API_KEY`，只用于自拍工具。生成图片默认写入 `assets/generated/selfies/`。
`SELFIE_IMAGE_API_BASE_URL` 缺失时会先看 `OPENAI_BASE_URL`，再回退到 `https://api.openai.com/v1`。

## TTS 配置

voice 模式默认先尝试本地 Genie-TTS 小服务；如果 Genie 模型目录、参考文本或启动加载不可用，会自动回退到 MOSS-TTS-Nano ONNX。两者默认第一次发送语音时自动启动服务，15 分钟空闲后关闭自己启动的进程：

- `TTS_BACKEND`
- `GENIE_TTS_HOST`
- `GENIE_TTS_PORT`
- `GENIE_TTS_BASE_URL`
- `GENIE_TTS_PYTHON_COMMAND`
- `GENIE_TTS_SERVICE_SCRIPT`
- `GENIE_TTS_DATA_DIR`
- `GENIE_TTS_MODEL_DIR`
- `GENIE_TTS_CHARACTER_NAME`
- `GENIE_TTS_LANGUAGE`
- `GENIE_TTS_REFERENCE_AUDIO`
- `GENIE_TTS_REFERENCE_TEXT`
- `GENIE_TTS_OUTPUT_DIR`
- `GENIE_TTS_TIMEOUT_MS`
- `GENIE_TTS_IDLE_SHUTDOWN_MS`
- `GENIE_TTS_FFMPEG_COMMAND`
- `MOSS_TTS_HOST`
- `MOSS_TTS_PORT`
- `MOSS_TTS_BASE_URL`
- `MOSS_TTS_PYTHON_COMMAND`
- `MOSS_TTS_SERVICE_SCRIPT`
- `MOSS_TTS_MODEL_DIR`
- `MOSS_TTS_REFERENCE_AUDIO`
- `MOSS_TTS_OUTPUT_DIR`
- `MOSS_TTS_TIMEOUT_MS`
- `MOSS_TTS_IDLE_SHUTDOWN_MS`
- `MOSS_TTS_FFMPEG_COMMAND`
- `MOSS_TTS_VOICE_CLONE_MAX_TEXT_TOKENS`

默认 Genie 模型目录是 `assets/tts/genie/models/alice`，参考音频是 `assets/tts/references/alice/reference.wav`，参考文本是同名 `assets/tts/references/alice/reference.txt`。管理后台上传声音样本时会同时保存 `reference.wav` 和 `reference.txt`。

MOSS fallback 的模型目录仍是 `assets/tts/moss-onnx/models`，生成语音临时写入 `assets/generated/tts/`，文件名使用本地日期时间，例如 `20260529_215419_123.opus`。如果设置了 `GENIE_TTS_BASE_URL` 或 `MOSS_TTS_BASE_URL`，Alice 会把对应后端视为外部服务地址，不再自动 spawn 本地服务。设置 `TTS_BACKEND=moss-onnx` 可以完全跳过 Genie。

Alice 会在每次 LLM request 开始时预启动 TTS 服务，而不是等到实际发送第一条语音；每日 04:00 会和系统日志清理一起删除前一日及更早的生成语音文件。

## Node 类型声明

`node-http.d.ts` 和 `globals.d.ts` 为当前原型使用到的 Node API 提供轻量类型声明。
