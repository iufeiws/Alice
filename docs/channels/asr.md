# ASR Channel

ASR channel 当前实现位于 `src/channels/asr`，为语音输入提供统一转写接口，并给 WebRTC voice、飞书语音入站和后台测试复用。

## Provider

当前 provider：

| provider | 说明 |
| --- | --- |
| `tencent` | 腾讯云 ASR，支持本地文件拆分和实时 WebSocket 入站 |
| `openai_compatible` | OpenAI 兼容音频转写接口 |
| `multimodal_llm` | 使用多模态 LLM 理解音频并通过工具提交结构化结果 |

`defaultProvider` 决定默认转写路径；调用方也可以在单次请求中指定 provider。

## 配置

主要配置字段：

- `enabled`
- `defaultProvider`
- `directAudioInputEnabled`
- `testAudioPath`
- `pseudoStreamMinPauseMs`
- `providers.openaiCompatible`
- `providers.multimodalLlm`
- `providers.tencent`

后台 Plugin registry 读写 ASR 配置；历史 `plugins/asr/config.json` 只作为迁移读取来源，不是新写入目标。

## 入站流

`createInboundStreamSession()` 接收 start/chunk/end/abort frame，并返回 ack、final 或 aborted。腾讯云可走实时 WebSocket；不支持真实流式的 provider 使用伪流式缓冲后转写。

## 输出

成功结果包含：

- `text`
- `provider`
- `model`
- `language`
- `durationMs`
- `requestId`
- `raw`
- `rawStream`

失败结果使用统一错误码，例如 `asr_disabled`、`missing_audio_file`、`missing_provider_config`、`provider_request_failed`、`empty_transcription`、`timeout`。

## Prompt 风险

当前 `multimodal_llm` provider 在代码中存在默认音频理解 prompt。按项目 prompt 构筑规则，后续如果要修改、迁移或删除该默认文本，必须先单独确认。本次文档整理不改代码和 prompt。
