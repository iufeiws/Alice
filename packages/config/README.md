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

Genie-TTS voice 模式依赖一个单独运行的 Genie HTTP 服务和本地资产：

- `GENIE_TTS_BASE_URL`
- `GENIE_TTS_CHARACTER_NAME`
- `GENIE_TTS_MODEL_DIR`
- `GENIE_TTS_LANGUAGE`
- `GENIE_TTS_REFERENCE_AUDIO`
- `GENIE_TTS_REFERENCE_TEXT`
- `GENIE_TTS_OUTPUT_DIR`
- `GENIE_TTS_TIMEOUT_MS`

默认情况下，模型目录是 `assets/tts/models/alice`，参考文件位于 `assets/tts/reference/`，生成语音临时写入 `assets/generated/tts/`。

## Node 类型声明

`node-http.d.ts` 和 `globals.d.ts` 为当前原型使用到的 Node API 提供轻量类型声明。
