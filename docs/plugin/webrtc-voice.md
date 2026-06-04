# WebRTC Voice Plugin 方案

本文档定义 `webrtc_voice` plugin 的首版设计。该 plugin 让用户在浏览器打开通话页后，通过 WebRTC 和 Alice 进行实时语音通话。它负责浏览器连接、WebRTC 信令、双向音频 track、流式 ASR 入站、`TalkRuntime` 入站接入，以及 Core 回复后的日语 TTS 出站播放。

当前实现状态：服务端 WebRTC peer、outbound audio track、ASR stream 和日语 TTS 播放队列先以可测试核心接口落地；`TalkRuntimeIngress.openSession()`、`ingestInput()` 和 `closeSession()` 暂不实际调用，只发出 `talk_runtime.*.todo` 状态。后续接入真实 `TalkRuntime` 时，必须把这些 todo 状态替换为正式入站事件。

首版强制使用服务端 WebRTC outbound audio track 播放 TTS 音频。不得把普通 HTTP 音频 URL 或浏览器 `<audio src>` 当作正式出站实现；URL 只能作为 debug、回放或后台检查的辅助手段。

## 目标

- 提供浏览器可直接打开的实时语音通话入口。
- 服务端作为 WebRTC peer 接收浏览器麦克风 audio track。
- 服务端在同一个 `RTCPeerConnection` 中创建 outbound audio track，并把 Alice 回复音频推给浏览器。
- 调用现有 ASR plugin 的流式入站能力，把用户语音转换成待送入 `TalkRuntime` 的事件候选。
- 把 ASR partial 映射为 `audio.transcript.delta`，把 ASR final 映射为 `audio.transcript.final`。
- 调用现有 `japanese_voice.voiceSynthesizer`，让 Core 回复先走日语 jp TTS，再通过 WebRTC outbound audio track 播放。
- `TalkRuntime` 入站当前标记为待实现；通话事实不得直接写 `messages` / `message_logs`。

## 非目标

- 不新增 ASR provider。
- 不新增 TTS provider。
- 不重新实现 japanese voice 翻译、jp Genie 参数或 voice model 配置。
- 不把 ASR partial 当作稳定历史或普通聊天消息。
- 不把浏览器原始音频二进制写入 SQLite。
- 不在首版实现把实时通话完整投影到 `MessageRuntime` 或 `messages`。
- 不用 HTTP 音频 URL 替代服务端 WebRTC outbound audio track。

## 用户场景

- 用户打开 `/plugins/webrtc-voice/call`，授权麦克风后开始和 Alice 语音通话。
- 用户说话时，浏览器通过 WebRTC 上传麦克风音频，服务端持续送入 ASR stream。
- Alice 根据稳定转写片段响应；回复文本经 `japanese_voice` 转日语并 TTS 合成。
- 浏览器通过 WebRTC 接收服务端 outbound audio track 并播放 Alice 语音。
- 用户在 Alice 播放中再次说话或点击打断时，当前播放队列停止，并向 `TalkRuntime` 发送 `input.interrupted`。

## 总体架构

```text
Browser call page
  -> WebSocket signaling
  -> WebRTC PeerConnection
     -> inbound microphone audio track
     -> server audio frame adapter
     -> ASR plugin streaming session
     -> talk_runtime.ingress.todo
     -> Core realtime handling
     -> japanese_voice.voiceSynthesizer
     -> TTS audio decode/transcode
     -> server outbound audio track
  -> Browser remote audio playback
```

边界职责：

| 组件 | 职责 |
| --- | --- |
| Browser page | 请求麦克风权限、创建 `RTCPeerConnection`、发送 offer/ICE、展示状态、播放 remote audio track。 |
| Signaling WebSocket | 交换 offer/answer/ICE、通话控制、错误、打断和状态事件；不承载主音频。 |
| WebRTC server peer | 接收浏览器 microphone track，创建并维护 outbound audio track。 |
| WebRTC voice plugin | 管理通话 session、ASR stream、TalkRuntime 入站 todo 状态、TTS 播放队列和打断。 |
| ASR plugin | 复用现有流式入站协议，返回 partial/final 识别结果。 |
| Japanese voice plugin | 复用现有 `japanese_voice.voiceSynthesizer`，使用 `language: "jp"` 的 Genie override。 |
| TalkRuntime | 接收实时入站事件、保序、去重、更新实时上下文并触发 Core。 |

## Plugin 标识

- plugin id：`webrtc_voice`
- `TalkInputEvent.source.plugin`：`webrtc_voice`
- `source.accountId`：默认 `main`
- `source.channelId`：浏览器通话 id，例如 `webrtc_voice:call:<callId>`
- `source.userId`：浏览器用户 id；未登录时可使用短期匿名 id，例如 `browser:<clientId>`
- `sessionId`：Core 侧实时会话 id，例如 `webrtc_voice:<callId>`

同一次浏览器通话必须始终使用同一个 `sessionId`。重连如果恢复同一通话，应复用原 `sessionId`；如果创建新通话，则生成新 `sessionId`。

## 浏览器入口

首版提供两个入口：

```text
GET /plugins/webrtc-voice/call
WebSocket /plugins/webrtc-voice/signaling
```

`GET /plugins/webrtc-voice/call` 返回通话页面。页面至少需要：

- 请求麦克风权限。
- 创建 `RTCPeerConnection`。
- 添加本地 microphone audio track。
- 监听 remote audio track 并交给浏览器音频播放管线。
- 通过 signaling WebSocket 发送 offer、接收 answer、交换 ICE candidate。
- 发送 hangup、interrupt 等控制消息。
- 展示连接、ASR、TTS、错误和通话状态。

`WebSocket /plugins/webrtc-voice/signaling` 只传控制消息：

```ts
type WebRtcVoiceSignal =
  | { type: "hello"; clientId?: string; locale?: string; timezone?: string }
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: unknown }
  | { type: "interrupt"; reason?: "manual" | "barge_in" }
  | { type: "hangup"; reason?: string }
  | { type: "status"; state: string; detail?: string }
  | { type: "error"; error: string; message?: string };
```

信令消息不得携带主音频 chunk。麦克风音频必须走 WebRTC inbound audio track，Alice 语音必须走服务端 WebRTC outbound audio track。

## 服务端 WebRTC 要求

服务端必须作为 WebRTC peer：

1. 接收浏览器 offer。
2. 创建 `RTCPeerConnection`。
3. 接收浏览器 microphone audio track。
4. 在同一个连接中创建服务端 outbound audio track。
5. 生成 answer 并通过 signaling WebSocket 返回。
6. 交换 ICE candidate。
7. 连接关闭时释放 ASR stream、播放队列、临时音频和 TalkRuntime session。

服务端 outbound audio track 是首版硬性要求：

- TTS 合成音频必须被解码或转码成 WebRTC 可发送的音频帧。
- 音频帧通过服务端 outbound audio track 发送给浏览器。
- 不允许用 HTTP 文件下载、普通 `<audio src>` 或轮询播放替代该 track。
- TTS 音频 URL 可以保留在 debug metadata 中，但不得作为正式播放路径。

建议服务端音频格式边界：

- WebRTC outbound track 内部使用 48 kHz mono PCM 帧或运行时 WebRTC 库要求的等价格式。
- TTS 输出如果是 opus、wav、mp3 或其他文件，先通过 ffmpeg 或等价音频管线解码/重采样。
- 每个 TTS 输出作为一个播放 item 进入 outbound queue，按顺序推送到 track。
- 队列停止时必须丢弃尚未发送的帧，并停止当前 item 的帧推送。

## ASR 入站流程

通话建立后，plugin 为每次通话创建：

- `talkSessionId`
- `asrStreamId`
- `sequence` 计数器
- WebRTC inbound audio adapter
- ASR stream session

启动流程：

```text
WebRTC connected
  -> generate talkSessionId and asrStreamId
  -> emit talk_runtime.open.todo
  -> asr.createAsrInboundStreamSession(startFrame)
  -> 待实现：talkRuntime.openSession() 和 session.started 入站
```

`startFrame` 使用现有 ASR 流式入站协议：

```ts
const startFrame = {
  type: "start",
  streamId: asrStreamId,
  audio: {
    mimeType: "audio/pcm",
    sampleRateHz: 16000,
    channels: 1,
    encoding: "pcm_s16le"
  },
  language: "ja",
  metadata: {
    plugin: "webrtc_voice",
    talkSessionId,
    callId
  }
};
```

音频帧处理：

- WebRTC inbound audio track 解码为 ASR provider 可接受的 chunk。
- 每个 chunk 转成 `InboundAudioStreamChunkFrame`。
- `chunk.sequence` 从 `0` 开始连续递增。
- `chunk.timing` 记录相对通话开始的 start/end/duration。
- chunk 的音频内容传给 ASR，不写入 SQLite。
- 如果需要调试音频数据，只保存受控 `dataRef` 或短期临时文件引用。

ASR 返回映射：

| ASR 返回 | TalkRuntime 事件 | 触发 Core | 说明 |
| --- | --- | --- | --- |
| `ack` | 不生成事件，或仅记 debug 状态 | 否 | 表示 chunk 被 ASR 接收。 |
| `partial` 且 `stable=false` | `audio.transcript.delta` | 否 | 只更新实时输入预览。 |
| `partial` 且 `stable=true` | `audio.transcript.delta` 或本地暂存 | 否 | 可作为候选稳定片段，但不触发 Core。 |
| `final` | 当前发出 `talk_runtime.ingress.todo`，后续接 `audio.transcript.final` | 待实现 | 稳定用户语义输入候选。 |
| `aborted` | `session.ended` 或 debug 状态 | 否 | 用户挂断或打断导致流结束。 |
| `error` | `session.ended` 或错误状态 | 可选 | 按错误类型决定是否关闭通话。 |

待实现的 `audio.transcript.final` 示例：

```ts
const event = {
  kind: "audio.transcript.final",
  sessionId: talkSessionId,
  source: {
    plugin: "webrtc_voice",
    accountId: "main",
    channelId: `webrtc_voice:call:${callId}`,
    userId
  },
  sequence: nextTalkSequence(),
  occurredAt,
  occurredAtUtc,
  payload: {
    kind: "transcript",
    text,
    language: "ja",
    segmentId
  },
  raw: {
    asrStreamId,
    provider,
    requestId
  }
};
```

## ASR Provider 策略

首版首选现有 ASR plugin 的流式能力：

- 腾讯云配置 `providers.tencent.appId` 时，使用腾讯云 WebSocket 实时识别。
- 腾讯云未配置 realtime 所需字段时，不应假装拥有低延迟实时识别；可以降级为 ASR plugin 的伪流式能力，并在状态中标记 `asr_mode=pseudo_stream`。
- OpenAI-compatible 如果只支持文件式识别，只能作为伪流式兼容降级；不作为首选低延迟路径。

当用户明确要求实时通话体验时，缺少原生流式 ASR 配置应在管理后台或通话页状态中提示：

```text
ASR is running in pseudo stream mode; final transcript latency may be higher.
```

## TTS 出站流程

Core 产生可播放回复文本后，plugin 执行：

```text
Core reply text
  -> japanese_voice.voiceSynthesizer({ text, time })
  -> japanese voice translation + jp Genie TTS
  -> generated audio file
  -> decode/transcode to outbound WebRTC audio frames
  -> enqueue frames
  -> server outbound audio track sends frames to browser
```

调用要求：

- 使用现有 `japanese_voice.voiceSynthesizer`。
- 不直接调用 Genie service 绕过 japanese voice plugin。
- 不复制 `japanese-voice/config.json` 的 voice 参数。
- TTS 使用 japanese voice plugin 现有行为：翻译到适合日语朗读的文本，并传入 `language: "jp"` 的 Genie override。
- TTS 失败时，按错误策略通知浏览器；不得把失败文本伪装为已播放音频。

播放队列要求：

- 每条 Core 回复生成一个 outbound playback item。
- playback item 至少包含 `outputId`、原始回复文本 hash、TTS asset id、临时文件路径、状态和创建时间。
- 队列按创建顺序播放。
- 新用户语音触发 barge-in 时，立即停止当前 item，并清空未开始的 item。
- 当前播放停止后，向浏览器发送状态事件，并向 `TalkRuntime` 发送 `input.interrupted`。

## 打断处理

打断来源：

- 浏览器发送 `{ type: "interrupt" }`。
- 服务端检测到用户在 Alice 播放期间开始说话。
- WebRTC 连接中断。
- ASR stream abort。

打断动作：

1. 停止 outbound audio track 当前播放 item 的帧推送。
2. 清空尚未播放的 TTS queue。
3. 如果 ASR stream 仍在运行，继续接收用户新输入；如果连接断开则 abort。
4. 当前发出 `talk_runtime.interrupt.todo`；待实现：调用 `talkRuntime.ingestInput()` 写入 `input.interrupted`。
5. 通过 signaling WebSocket 发送播放中断状态。

`input.interrupted` 示例：

```ts
const event = {
  kind: "input.interrupted",
  sessionId: talkSessionId,
  source: {
    plugin: "webrtc_voice",
    accountId: "main",
    channelId: `webrtc_voice:call:${callId}`,
    userId
  },
  sequence: nextTalkSequence(),
  occurredAt,
  occurredAtUtc,
  payload: {
    kind: "interrupt",
    reason: "barge_in",
    targetOutputId
  },
  raw: {
    playbackItemId,
    asrStreamId
  }
};
```

## 会话结束

正常挂断、浏览器关闭、WebRTC failed、signaling WebSocket close 或服务端异常都必须收敛到统一关闭流程：

```text
stop outbound playback
  -> clear TTS queue
  -> send ASR abort or end
  -> emit talk_runtime.close.todo
  -> 待实现：talkRuntime.ingestInput(session.ended) 和 talkRuntime.closeSession()
  -> close PeerConnection
  -> close signaling WebSocket
  -> delete temporary playback files when safe
```

`session.ended` 不代表一定有最后一句用户输入。只有 ASR final 或 text final 才是稳定用户语义输入。当前实现不实际写入 `session.ended`，只发出 close todo 状态。

## 配置

建议配置：

```ts
type WebRtcVoicePluginConfig = {
  enabled: boolean;
  callPath: "/plugins/webrtc-voice/call";
  signalingPath: "/plugins/webrtc-voice/signaling";
  accountId: "main";
  asrProvider?: "tencent" | "openai_compatible";
  language: "ja";
  inboundAudio: {
    sampleRateHz: 16000;
    channels: 1;
    encoding: "pcm_s16le";
    chunkMs: number;
  };
  outboundAudio: {
    sampleRateHz: 48000;
    channels: 1;
    frameMs: number;
  };
  iceServers: Array<{
    urls: string | string[];
    username?: string;
    credential?: string;
  }>;
  bargeIn: {
    enabled: boolean;
    minSpeechMs: number;
  };
  timeouts: {
    signalingIdleMs: number;
    peerConnectionMs: number;
    ttsPlaybackStartMs: number;
  };
};
```

默认建议：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 未启用时拒绝创建通话。 |
| `language` | `ja` | 用户通话识别语言。 |
| `inboundAudio.sampleRateHz` | `16000` | ASR 输入采样率。 |
| `inboundAudio.chunkMs` | `100` | 送入 ASR 的音频 chunk 时长。 |
| `outboundAudio.sampleRateHz` | `48000` | WebRTC outbound track 常用采样率。 |
| `outboundAudio.frameMs` | `20` | outbound track 推帧粒度。 |
| `bargeIn.enabled` | `true` | 用户说话时打断当前 TTS 播放。 |
| `bargeIn.minSpeechMs` | `250` | 避免短噪声触发打断。 |
| `timeouts.signalingIdleMs` | `30000` | signaling 长时间无活动后关闭。 |

## 错误处理

统一错误码：

| 错误 | 含义 | 默认处理 |
| --- | --- | --- |
| `plugin_disabled` | plugin 未启用 | 拒绝通话并返回错误状态。 |
| `microphone_permission_denied` | 浏览器拒绝麦克风权限 | 页面提示用户授权。 |
| `signaling_failed` | WebSocket 信令失败 | 关闭通话。 |
| `webrtc_negotiation_failed` | offer/answer/ICE 失败 | 关闭 PeerConnection。 |
| `inbound_track_missing` | 未收到麦克风 track | 关闭通话。 |
| `outbound_track_failed` | 服务端 outbound audio track 创建或推帧失败 | 停止播放并保留通话入站能力，必要时关闭通话。 |
| `asr_stream_failed` | ASR stream 失败 | 通知浏览器；无法恢复时关闭通话。 |
| `tts_failed` | japanese voice TTS 失败 | 跳过该播放 item，通知浏览器。 |
| `playback_interrupted` | 播放被用户或 barge-in 打断 | 停止当前 item 并写入 `input.interrupted`。 |
| `session_closed` | 通话已关闭仍收到事件 | 忽略事件并记录 debug。 |

错误日志不得记录 API key、完整原始音频、完整 TTS 音频内容或 provider 原始敏感响应。

## 日志与隐私边界

- 默认记录 call id、session id、连接状态、ASR provider、ASR mode、TTS 状态、耗时、错误码。
- 默认不记录完整原始音频。
- 默认不记录完整 ASR partial。
- ASR final 可以进入 `TalkRuntime` 稳定片段；是否进一步进入聊天历史由后续设计决定。
- TTS 生成文件按现有 generated voice 清理策略处理。
- Debug 模式可以记录音频 `dataRef` 和 provider request id，但必须避免泄露凭证。
- WebRTC ICE server credential 不写入前端可见日志。

## 与 MessageRuntime 的关系

`webrtc_voice` 不调用 `MessageRuntime.ingestEvent()` 处理实时语音。实时通话的临时音频帧、ASR delta、打断和 session 状态都属于 `TalkRuntime` 语义。

当前实现也暂不调用 `TalkRuntimeIngress`。ASR final、open、interrupt、close 只通过状态事件标记为 `talk_runtime.*.todo`，用于先完成 WebRTC/TTS/ASR 插件边界。

后续如果需要把通话摘要或最终片段写入聊天历史，应由单独的投影流程从 `talk_segments` 生成 `messages`，并保留 `sessionId` / `segmentId` 映射，避免重复归纳或重复展示。

## 验收标准

- 浏览器可以打开 `/plugins/webrtc-voice/call` 并建立 signaling WebSocket。
- 浏览器授权麦克风后，服务端能完成 WebRTC offer/answer/ICE 协商。
- 服务端能收到 browser microphone audio track。
- 服务端必须创建 WebRTC outbound audio track，并让浏览器通过 remote track 接收 Alice 音频。
- 建立通话后会发出 `talk_runtime.open.todo`；待实现：调用 `talkRuntime.openSession()` 并写入 `session.started`。
- 麦克风音频 chunk 会进入 ASR stream。
- ASR partial 映射为 `audio.transcript.delta`，不触发稳定 Core 输入。
- ASR final 当前发出 `talk_runtime.ingress.todo`；待实现：映射为 `audio.transcript.final`，进入 `TalkRuntime` 并可触发 Core。
- Core 回复文本经 `japanese_voice.voiceSynthesizer` 合成后，通过服务端 outbound audio track 播放。
- 正式播放路径不得依赖 HTTP 音频 URL。
- 播放中断会停止当前 outbound 帧推送、清空播放队列，并发出 `talk_runtime.interrupt.todo`；待实现：写入 `input.interrupted`。
- 挂断或断网会 abort ASR stream、停止 outbound track、关闭 PeerConnection，并发出 `talk_runtime.close.todo`；待实现：调用 `talkRuntime.closeSession()`。
- ASR/TTS 缺配置、WebRTC 失败、浏览器权限拒绝、网络断开都有明确错误状态。

## 后续问题

- 服务端 WebRTC 库选型：Node 侧使用 `wrtc`、mediasoup、werift，还是独立 realtime media service。
- Core 回复到 WebRTC voice plugin 的回调接口如何定义，是否需要扩展 `TalkRuntime` 出站协议。
- outbound audio track 是否需要支持低延迟边合成边播放，还是首版按完整 TTS 文件播放。
- 浏览器端是否需要显示 ASR delta 和 Alice 当前播放字幕。
- 多用户或房间通话是否作为后续独立场景处理。
