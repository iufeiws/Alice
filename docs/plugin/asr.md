# ASR 通用包装 Plugin 方案

本文档定义 ASR（Automatic Speech Recognition，语音识别）通用包装 plugin 的目标、接口和 provider 接入边界。该 plugin 接收调用方传入的语音文件，或按流式入站协议接收音频帧，调用已配置的 ASR 服务，将识别结果统一返回为文字。

## 目标

- 提供一个统一 ASR 包装入口，调用方只关心“传入语音文件，返回文字”。
- 首要实现腾讯云 ASR API。
- 首要实现 OpenAI 兼容 ASR API，用于接入硅基流动 API 和 OpenAI API。
- 统一 provider 返回结构，避免业务层感知不同供应商的响应格式。
- 统一配置入口：OpenAI 兼容 provider 复用后台 API preset；腾讯云 provider 在 ASR plugin 内单独配置 SecretId 和 SecretKey。
- 为后续科大讯飞、本地部署等 provider 预留接口，但本阶段不实现。

## 非目标

- 本阶段不实现科大讯飞 ASR。
- 本阶段不实现本地部署 ASR。
- 本阶段实现流式入站协议。腾讯云支持原生 WebSocket 实时识别；不支持原生流式的 provider 使用伪流式，在 `end` 后合并音频并调用文件式 ASR。
- 本阶段不实现说话人分离、字级时间戳、翻译、摘要或语音增强。
- 本阶段不提供跨 provider 的识别质量评测系统。
- 本阶段不改变上游语音采集、上传和存储流程。

## 用户场景

- 调用方上传或传入一段语音文件，希望得到一段纯文字。
- 用户在聊天、日志、语音笔记等入口录音后，由 ASR plugin 把音频转成文本再交给后续流程。
- 系统希望根据配置在腾讯云、硅基流动或 OpenAI 之间切换 ASR provider，而不改业务调用代码。

## 通用接口

plugin 对外暴露一个统一识别接口：

```ts
type AsrProvider = "tencent" | "openai_compatible";

type AsrTranscribeInput = {
  audioFile: File | Blob | Buffer | string;
  filename?: string;
  mimeType?: string;
  language?: string;
  provider?: AsrProvider;
  prompt?: string;
  metadata?: Record<string, unknown>;
};

type AsrTranscribeResult = {
  text: string;
  provider: AsrProvider;
  model?: string;
  language?: string;
  durationMs?: number;
  requestId?: string;
  raw?: unknown;
  rawStream?: {
    streamId: string;
    chunks: number;
    bytes: number;
    metadata?: Record<string, unknown>;
  };
};
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `audioFile` | 必填。调用方传入的语音文件，可以是文件对象、二进制数据或本地文件路径。 |
| `filename` | 可选。传给 provider 的文件名；当 `audioFile` 是路径时可从路径派生。 |
| `mimeType` | 可选。音频 MIME 类型；缺失时由文件名或内容推断。 |
| `language` | 可选。识别语言，例如 `zh`、`ja`、`en`。不传时由 provider 自动识别或使用 provider 默认值。 |
| `provider` | 可选。指定 ASR provider；不传时使用 plugin 配置中的默认 provider。 |
| `prompt` | 可选。OpenAI 兼容 ASR 可使用的提示词，用于提高专有名词或上下文识别效果。 |
| `metadata` | 可选。调用方附加上下文，只用于 trace 或 provider 扩展，不作为稳定业务协议。 |

最小调用语义：

```text
audio file -> ASR plugin -> selected provider -> normalized text result
```

## 流式入站协议

流式入站协议用于上游边录边传音频。provider 层分两种能力：

- `native_stream`：provider 原生支持实时流式识别。腾讯云配置 `appId` 后走 WebSocket 实时识别，`chunk` 会作为 binary message 发送，provider 返回的非稳态和稳态结果会作为 `partial` 返回。
- `pseudo_stream`：provider 不支持或未配置原生流式。系统基于保守长停顿切段，达到阈值时先识别上一段并返回稳定 `partial`；`end` 时识别最后一段并汇总最终文本。OpenAI-compatible 当前走此模式。

协议帧：

```ts
type InboundAudioStreamFrame =
  | {
      type: "start";
      streamId: string;
      audio: {
        filename?: string;
        mimeType?: string;
        sampleRateHz?: number;
        channels?: number;
        encoding?: string;
      };
      language?: string;
      provider?: "tencent" | "openai_compatible";
      prompt?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "chunk";
      streamId: string;
      sequence: number;
      bytes: Uint8Array;
      timing?: {
        startMs?: number;
        endMs?: number;
        durationMs?: number;
      };
      metadata?: Record<string, unknown>;
    }
  | {
      type: "end";
      streamId: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "abort";
      streamId: string;
      reason?: string;
      metadata?: Record<string, unknown>;
    };
```

协议规则：

- `start` 创建一个入站音频流 session。
- `chunk.sequence` 必须从 `0` 开始连续递增；乱序 chunk 返回 `out_of_order_chunk`。
- `chunk.timing`、`metadata`、文件名、MIME、采样率等都属于结构化元数据，禁止拼进转写文本。
- 伪流式只在相邻 chunk 的 `next.startMs - previous.endMs >= pseudoStreamMinPauseMs` 时切段；默认阈值为 `1500ms`。没有 timing 时不做中途切段，只在 `end` 后整体识别。
- `end` 关闭流，合并 chunk 二进制，并调用当前配置的 ASR provider。
- `abort` 关闭流，不调用 ASR provider。
- `end` 后返回的 `text` 必须是净化后的纯文本；如果 provider 返回 `[语音][0:0.020,0:5.000] 正文` 一类内容，进入下游前只保留正文。
- 流元信息只允许出现在 `metadata` 或 `rawStream`，不能作为正文传给后续插件、核心或记忆。

腾讯云原生流式规则：

- 需要配置 `providers.tencent.appId`、`secretId`、`secretKey` 和 `engineModelType`。
- WebSocket 地址为 `wss://asr.cloud.tencent.com/asr/v2/<appid>?...`。
- 签名按腾讯云实时语音识别 WebSocket 文档要求，对除 `signature` 外的参数按字典序拼接，使用 `SecretKey` 做 HMAC-SHA1 后 Base64，再 URL encode。
- `chunk.bytes` 作为 WebSocket binary message 发送；`end` 帧发送 `{"type":"end"}`。
- 腾讯返回 `slice_type=1` 时作为非稳态 `partial`，`slice_type=2` 时作为稳态 `partial` 并参与最终文本汇总。
- 腾讯返回的 `start_time`、`end_time`、`word_list` 等只保留在原始响应或元数据中，不拼进正文。

## Provider 优先级

### 腾讯云 ASR

腾讯云 API 是首要实现方案之一。实现层负责把通用输入转换为腾讯云请求格式，并把腾讯云响应归一化为 `AsrTranscribeResult`。

接入要求：

- 支持在 ASR plugin 配置中单独填写腾讯云 `SecretId` 和 `SecretKey`。
- 腾讯云官方凭证是一对 `SecretId` / `SecretKey`；`SecretId` 用于标识调用者，`SecretKey` 用于生成请求签名。
- 支持常见音频格式，例如 `wav`、`mp3`、`m4a`、`ogg`，具体以腾讯云 API 支持范围为准。
- 腾讯云本地文件上传单次 chunk 最大为 5 MB；超过限制的音频必须先拆分为多个 chunk，再逐段创建识别任务。
- 拆分优先基于静音停顿点；没有合适停顿点时按时长均分兜底，保证每个 chunk 都能提交。
- 每个 chunk 独立调用 `CreateRecTask`，再通过 `DescribeTaskStatus` 轮询结果。
- 多个 chunk 的识别文本按原顺序用换行拼接。
- 返回结果必须归一化为 `text`。
- 如果腾讯云返回 request id，应写入 `requestId`。
- 腾讯云原始响应只放入 `raw`，业务层默认不依赖 `raw`。

### OpenAI 兼容 ASR

OpenAI 兼容 API 是首要实现方案之一，用于接入硅基流动 API 和 OpenAI API。硅基流动和 OpenAI 在 plugin 内走同一个 OpenAI-compatible provider，只通过 `baseURL`、`apiKey`、`model` 等 preset 配置区分。

接入要求：

- 使用统一的 OpenAI 兼容 multipart file upload 调用形态。
- API preset 提供 `baseURL`、`apiKey`、`model` 等配置。
- 硅基流动和 OpenAI 不在业务接口层拆成两个 provider。
- 返回结果必须归一化为 `text`。
- provider 原始响应只放入 `raw`，业务层默认不依赖 `raw`。

建议 provider 配置：

```ts
type OpenAiCompatibleAsrConfig = {
  apiPresetName: string;
  responseFormat?: "json" | "text" | "verbose_json";
  retryCount?: number;
  retryBackoffMs?: number;
};
```

## 暂不实现 Provider

以下 provider 只保留设计入口，本阶段没有开发计划：

| Provider | 状态 | 说明 |
| --- | --- | --- |
| 科大讯飞 | planned | 后续可作为独立 provider 接入，当前不实现。 |
| 本地部署 | planned | 后续可接 Whisper、FunASR 等本地服务，当前不实现。 |

预留 provider 不应出现在默认可选项中，除非已经有可运行实现和测试。

## Plugin 配置

后台配置保存 provider 选择。OpenAI 兼容 provider 保存 API preset 引用；腾讯云 provider 独立保存腾讯云 ASR 所需凭证：

```ts
type AsrPluginConfig = {
  enabled: boolean;
  defaultProvider: AsrProvider;
  pseudoStreamMinPauseMs?: number;
  providers: {
    tencent?: {
      appId?: string;
      secretId: string;
      secretKey: string;
      endpoint?: string;
      region?: string;
      engineModelType?: string;
      realtimeVoiceFormat?: number;
      realtimeNeedVad?: 0 | 1;
      pollIntervalMs?: number;
      timeoutMs?: number;
      retryCount?: number;
      retryBackoffMs?: number;
      maxChunkBytes?: number;
      splitSilenceThresholdDb?: number;
      splitMinSilenceMs?: number;
    };
    openaiCompatible?: {
      apiPresetName: string;
      responseFormat?: "json" | "text" | "verbose_json";
      retryCount?: number;
      retryBackoffMs?: number;
    };
  };
};
```

配置规则：

- `enabled` 为 false 时，plugin 不应执行外部 ASR 请求。
- `defaultProvider` 决定调用方未显式指定 provider 时使用哪个实现。
- OpenAI 兼容 provider 的 `apiPresetName` 指向后台统一 API preset；ASR 模型名称由该 preset 的 `model` 字段配置，plugin 不重复保存模型名。
- 腾讯云 provider 不复用 LLM API preset，直接在 ASR plugin 的 Tencent Cloud 分组中配置 `secretId` 和 `secretKey`。
- provider 缺少必要配置时，plugin 应返回明确的配置错误。

超时、重试与拆分配置：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `providers.tencent.appId` | 无 | 腾讯云实时 WebSocket ASR 所需 AppID；配置后腾讯流式入站走原生实时识别，不配置时走伪流式。 |
| `providers.tencent.secretId` | 无 | 腾讯云 API 密钥对中的 SecretId。 |
| `providers.tencent.secretKey` | 无 | 腾讯云 API 密钥对中的 SecretKey，用于签名请求。 |
| `providers.tencent.endpoint` | `https://asr.tencentcloudapi.com` | 腾讯云 ASR API endpoint。 |
| `pseudoStreamMinPauseMs` | `1500` | 伪流式保守长停顿切段阈值。只有相邻 chunk 的 timing 间隔达到该值才切段识别。 |
| `providers.tencent.realtimeVoiceFormat` | 按音频类型推断 | 腾讯云实时 WebSocket `voice_format`；pcm=1、mp3=8、opus=10、wav=12、m4a=14、aac=16。 |
| `providers.tencent.realtimeNeedVad` | `1` | 腾讯云实时 WebSocket `needvad`；1 开启 VAD，0 关闭。 |
| `providers.openaiCompatible.retryCount` | `1` | OpenAI 兼容请求超时、网络错误或 5xx 时的重试次数。 |
| `providers.openaiCompatible.retryBackoffMs` | `500` | OpenAI 兼容请求重试基础等待时间。第 N 次重试按 `retryBackoffMs * N` 等待。 |
| `providers.tencent.timeoutMs` | `120000` | 腾讯云单次请求和整段 chunk 轮询的超时上限。 |
| `providers.tencent.pollIntervalMs` | `1000` | 腾讯云 `DescribeTaskStatus` 轮询间隔。 |
| `providers.tencent.retryCount` | `1` | 腾讯云 `CreateRecTask` 和 `DescribeTaskStatus` 超时、网络错误或 5xx 时的重试次数。 |
| `providers.tencent.retryBackoffMs` | `500` | 腾讯云请求重试基础等待时间。第 N 次重试按 `retryBackoffMs * N` 等待。 |
| `providers.tencent.maxChunkBytes` | `5242880` | 腾讯云本地上传 chunk 字节上限。不能超过 5 MB。 |
| `providers.tencent.splitSilenceThresholdDb` | `-35` | 使用 ffmpeg `silencedetect` 识别停顿的音量阈值。 |
| `providers.tencent.splitMinSilenceMs` | `700` | 被认为可用于切分的最短静音时长。 |

拆分规则：

- 当腾讯云 provider 的本地音频不超过 `maxChunkBytes` 时，直接提交。
- 当本地音频超过 `maxChunkBytes` 时，使用 ffmpeg 分析静音点，并优先在接近目标 chunk 大小的位置按停顿切分。
- 如果没有合适停顿点，则按时长均分兜底。
- 如果兜底切分后某个 chunk 仍超过 `maxChunkBytes`，继续细分；仍无法满足时返回 `unsupported_audio_format`。
- 拆分只改变 provider 请求方式，不改变调用方输入输出协议。

## 错误处理

统一错误类型：

| 错误 | 含义 |
| --- | --- |
| `asr_disabled` | plugin 未启用。 |
| `missing_audio_file` | 未传入语音文件。 |
| `unsupported_audio_format` | 音频格式不支持或无法识别。 |
| `missing_provider_config` | 目标 provider 缺少必要配置。 |
| `provider_request_failed` | provider 请求失败。 |
| `empty_transcription` | provider 返回成功但文本为空。 |
| `timeout` | ASR 请求超时。 |

错误返回应包含 provider、错误码、可读错误信息和可选 request id。默认不把完整音频内容、API key 或 provider 原始错误中的敏感字段写入日志。

## 日志与隐私边界

- 默认日志只记录 provider、模型、耗时、状态和 request id。
- 默认不记录完整音频文件内容。
- 默认不记录完整识别文本，除非调用方显式进入调试模式。
- provider 原始响应可以进入 debug trace，但需要避免泄露密钥和音频内容。
- 如果调用方需要保存识别文本，应由调用方在业务层显式保存。

## 验收标准

- 调用方可以传入语音文件并拿到 `text`。
- 调用方可以按 `start/chunk/end/abort` 流式入站协议提交音频，并在 `end` 后拿到 `text`。
- 未指定 provider 时使用 `defaultProvider`。
- 腾讯云 ASR provider 可以完成一次端到端识别，并返回归一化结果。
- OpenAI 兼容 ASR provider 可以通过硅基流动 API 完成一次端到端识别，并返回归一化结果。
- OpenAI 兼容 ASR provider 可以通过 OpenAI API 完成一次端到端识别，并返回归一化结果。
- provider 失败时返回统一错误，不把供应商响应格式泄露给业务层。
- 科大讯飞和本地部署只作为 planned provider 保留，不在当前实现中暴露为可用选项。

## 后续问题

- ASR plugin 的配置文件最终放在 `plugins/asr/config.json`，还是统一接入后台 Plugin registry？
- 是否需要把音频文件统一复制到 `assets/plugin/asr/` 后再调用 provider？
- OpenAI 兼容 ASR 的默认 `model` 是否由 API preset 决定，还是由 ASR plugin 配置单独指定？
- 是否需要为长音频增加异步任务接口和轮询状态？
