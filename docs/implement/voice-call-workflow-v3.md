# Voice Call 工作流 V3

本文描述当前 voice call 的实现架构。重点是播放消费者、barge-in 断点、TTS streaming 队列和浏览器出声之间的所有权边界。

## 核心原则

voice call 的主路径分成四层：

```text
TalkRuntime -> Runtime Output Pump -> TTS producer/frameQueue -> playback consumer/outbound track
```

所有权规则：

- TalkRuntime 是会话事实层，保存 output、chunk、interrupt 和稳定用户输入。
- Runtime Output Pump 只负责 claim ready chunk，并启动对应的 TTS 播放任务。
- TTS producer 只负责把 provider 音频转成 frame，不能决定当前听到什么。
- playback consumer 是唯一“正在播放什么”的来源，也是 barge-in target 的来源。
- playbackQueue 只是待播顺序队列，不能作为断点文本来源。
- frameQueue 只是流式音频帧缓冲，不能代表浏览器已经播放到哪里。

## 当前数据结构

### PlaybackItem

`PlaybackItem` 是队列 item 和 producer 的局部元数据容器。

```ts
type PlaybackItem = {
  outputId?: string;
  chunkId?: string;
  originalText?: string;
  speakText?: string;
  textHash: string;
  assetId: string;
  filePath: string;
  status: "queued" | "playing" | "played" | "interrupted" | "cancelled" | "failed";
  createdAt: string;
  framesWritten: number;
  playedMs?: number;
  totalMs?: number;
  interruptEpoch?: number;
  streamingTts?: boolean;
  playbackTextCache?: string;
  ttsAudioTextSpans?: PlaybackAudioTextSpan[];
};
```

这些字段的意义：

- `outputId`、`chunkId`：TalkRuntime output/chunk 标识，用于播放完成和 interrupt runtime 调用。
- `originalText`、`speakText`：原始文本和过滤后送 TTS 的文本。
- `status`：item 生命周期状态，仅用于队列和清理。
- `framesWritten`、`playedMs`、`totalMs`：item 级播放统计，不是 barge-in 的最终事实来源。
- `streamingTts`：标识该 item 来自 streaming TTS。
- `playbackTextCache`：producer/item 上的临时文本缓存，用于把后续 frame 标注成哪个文本。它不能作为 barge-in target 的权威来源。
- `ttsAudioTextSpans`：当前仍可作为 producer 侧临时映射数据存在，用于把 provider audio chunk 对应到文本段。但 breakpoint 当前不依赖 spans，不按 spans 切。

### PlaybackConsumer

`PlaybackConsumer` 是当前播放消费者状态，也是 barge-in target。

```ts
type PlaybackConsumer = {
  outputId?: string;
  chunkId?: string;
  playbackTextCache: string;
  playedMs: number;
  totalMs: number;
};
```

字段规则：

- `outputId`、`chunkId`：当前消费者正在播放的 runtime target。
- `playbackTextCache`：当前消费者正在播放的文本。它必须来自已经被消费者消费的 frame，不能来自队列 peek，也不能来自后续 producer。
- `playedMs`：消费者已经写出的真实音频时长。underrun 静音不增加该值。
- `totalMs`：当前文本对应音频总时长。必须已知；`totalMs <= 0` 时不能计算断点。

voice call 不需要保存 `idle | queued | playing | between_chunks | ended` 这类消费者状态。消费者只表达一件事：当前正在播放的内容和进度。没有内容时继续轮询队列。

### PlaybackFrame

streaming TTS 进入 frameQueue 时使用局部 frame 元数据：

```ts
type PlaybackFrame = {
  frame: ServerAudioFrame;
  text?: string;
  textTotalMs?: number;
};
```

这些元数据只用于消费者真正取到 frame 时更新 `PlaybackConsumer`。它们不能提前污染消费者。

## 正常播放流程

1. TalkRuntime 产生 ready output chunk。
2. Runtime Output Pump 调用 `claimReadyOutputChunk(sessionId)`。
3. Pump 调用 `playReplyText(chunk.text, chunk.outputId, { chunkId, originalText })`。
4. TTS producer 开始 streaming，收到 audio chunk 后编码成 outbound audio frame。
5. producer 把 `{ frame, text, textTotalMs }` push 到当前 item 的 frameQueue。
6. streaming 播放等待初始缓冲，当前阈值是 `max(20 frames, 1200ms / frameMs)`；默认 `frameMs = 20ms` 时是 60 帧。
7. playback worker 通过 `waitForPlaybackTurn(item)` 确认 gate 打开、item 在队首、没有其它 current playing item。
8. 第一个真实 frame 被消费者取到时，才初始化 `PlaybackConsumer`。
9. 初始化消费者后执行 `beforeFirstPlayback`，当前 Runtime Output Pump 会在这里 sleep 1000ms。
10. 随后发出 `voice_call.connected`，再写 outbound audio frame。
11. 每写出一帧真实音频，更新 item 统计和 consumer `playedMs`。
12. item 播放完成后标记 `tts.played`，并由 Pump 调用 `markOutputChunkPlayed(chunkId)`。

关键约束：

- `beforeFirstPlayback`、`voice_call.connected`、浏览器 unmute 这类“开始播放”语义必须依赖消费者拿到第一帧，而不是依赖队列中有 frame。
- 不能使用 `peek()` 把队列头文本提前写入消费者。
- 后续 chunk 可以已经 claim 或开始 TTS，但只要消费者没有消费它的 frame，就不能成为 barge-in 的前文。

## Barge-in 与断点

用户按下 push-to-talk 且 barge-in enabled 时：

1. `setSpeechActive(true)` 发出 `tts.barge_in`。
2. 调用 `interrupt("barge_in")`。
3. interrupt target 从 `PlaybackConsumer` 取：
   - `targetOutputId = playbackConsumer.outputId`
   - `targetChunkId = playbackConsumer.chunkId`
4. 如果 consumer 没有 outputId，才退化为 explicit target 或 `interruptLatestOutput`。
5. 断点上下文从 consumer 计算，不从 playbackQueue、frameQueue、producer item 或后续 chunk 计算。

断点计算：

```ts
const ratio = clamp(playbackConsumer.playedMs / playbackConsumer.totalMs, 0, 1);
const index = Math.round(Array.from(playbackConsumer.playbackTextCache).length * ratio);
beforeText = chars.slice(0, index).join("");
afterText = chars.slice(index).join("");
```

规则：

- `playbackTextCache` 为空或 `totalMs <= 0` 时，不提交 breakpointContext。
- 当前不使用 spans、音素 timing 或 provider word timing。
- 当前不提交 `breakpointCharIndex`，只提交 `{ beforeText, afterText }`。
- `playedMs / totalMs` 只作用于当前 consumer 文本，不跨 chunk。
- 队列里已经有下一段文本但当前段还没播完时，barge-in 仍以当前 consumer 文本为准。
- 当前段已播完、下一段还没被消费者消费时，consumer 仍保持上一段缓存；这个中间点的前文使用 consumer cache，而不是取队列 undefined 或后续文本。

interrupt 时 voice call 会：

- `playbackGeneration += 1`。
- abort active TTS tasks。
- 将 playbackQueue 中匹配 target 的 item 标记 `interrupted`，其它标记 `cancelled`。
- 清空 playbackQueue。
- 调用 TalkRuntime `interruptOutput` 或 `interruptLatestOutput`。
- 发出 `talk_runtime.interrupt.breakpoint: 前文=... 后文=...`。

## Streaming TTS 与 frameQueue

streaming 路径中有两个并行角色：

- producer：读取 TTS stream，编码 PCM chunk，push frame。
- consumer：按播放顺序 shift frame，并写 outbound track。

producer 可以比 consumer 快，也可能在句中暂停。consumer 不能因为 producer 暂停就结束播放；只要 frameQueue 未 closed 且 item 未 interrupted/cancelled，就要继续等待后续 frame。

producer 完成后关闭 frameQueue，并发出：

- `tts.stream.done`
- `tts.queue.producer_done`

consumer 只在 frameQueue closed 且当前没有 frame 时结束当前 item。

## Underrun 与静音补帧

浏览器 WebRTC audio 需要持续 RTP 时钟。streaming TTS 中如果 producer 暂停，消费者可能遇到 frameQueue 空但 stream 还未结束。

当前策略：

1. consumer shift 不到 frame 且 frameQueue 未 closed 时，发出 `tts.queue.underrun`。
2. 先 `await Promise.resolve()`，给 producer 一次 microtask 机会把刚生成的 frame 入队。
3. 如果仍没有 frame，计算下一帧理论发送点：

```ts
nextFrameAt = playbackStartedAt + playbackFrameCount * outboundAudio.frameMs;
remainingMs = nextFrameAt - now();
```

4. 如果 `remainingMs >= 20`，先等待到接近发送点，或等待 frameQueue 有新 frame。
5. 如果 `remainingMs < 20` 且仍无真实 frame，才向 outbound track 写一帧静音。
6. 静音帧写出后推进 RTP timestamp 和 `playbackFrameCount`。
7. 静音帧不推进 `PlaybackConsumer.playedMs`，也不推进 item 的真实 `framesWritten`。
8. 真正的后续 frame 到达后，consumer 立即恢复真实播放，并发出 `tts.queue.resumed`。

静音帧是 underrun 期间的 RTP 连续性补偿，不是每段语音后的固定尾帧。不能在每段末尾固定追加安静帧。

## RTP 时间戳

outbound frame 写出前统一 stamp：

- `sequence` 使用 call 级 `outboundFrameSequence`。
- `rtpTimestamp` 使用 call 级 `outboundRtpTimestamp`。
- 写出成功后按 frame 的 `rtpTimestampIncrement` 或 `sampleRateHz * durationMs / 1000` 推进 RTP clock。

真实 frame 和 underrun 静音 frame 共享同一 RTP clock，避免浏览器 jitter buffer 因 timestamp 回退或跳变丢后续音频。

## 事件语义

常用事件：

- `tts.queue.waiting`：等待初始缓冲。
- `tts.queue.ready`：初始缓冲或 producer close 后可进入播放。
- `tts.playback.consumer`：消费者文本被真实 frame 激活。
- `voice_call.connected`：第一帧真实播放路径已开始，页面可认为通话出声。
- `tts.playing_text`：当前播放文本。
- `tts.playing_text.missing`：frame 缺少可映射文本。
- `tts.queue.underrun`：consumer 需要 frame 但 frameQueue 暂时为空。
- `tts.queue.silence`：underrun 期间实际写出静音补帧。
- `tts.queue.resumed`：underrun 后恢复真实 frame。
- `tts.barge_in`：用户开始说话触发打断。
- `talk_runtime.interrupt.breakpoint`：提交给 TalkRuntime 前计算出的前文/后文。

## 验收标准

- 当前播放前文必须来自 `PlaybackConsumer.playbackTextCache`。
- 队列中的下一段文本不能提前覆盖 consumer。
- `totalMs <= 0` 时不能计算断点。
- breakpoint 只按 `playedMs / totalMs` 比例切当前 consumer 文本。
- 不依赖 spans 计算 breakpoint。
- `beforeFirstPlayback` 和 `voice_call.connected` 必须发生在消费者拿到第一帧之后。
- streaming producer 暂停时不能吞掉后续真实 frame。
- underrun 时只有剩余时间小于 20ms 才补静音。
- 静音补帧不能增加 consumer `playedMs`。
- 真实 frame 恢复后 RTP timestamp 必须连续。
- 不允许在每段语音末尾固定追加安静帧。
- barge-in 时 target 以消费者为准；没有消费者 target 时才 interrupt latest。
