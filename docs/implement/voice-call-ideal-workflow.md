# Voice Call 理想工作流

本文记录 voice call 在 Talk Loop demo 中应当遵守的理想运行模型。目标不是描述当前代码现状，而是固定实现应收敛到的部件、worker、队列和时序。

## 核心原则

- voice call 的实时路径是 `runtime -> TTS producer -> 待播队列 -> playback worker`。
- voice call 只拥有通话传输、ASR/TTS/playback、barge-in 检测和本地队列；会话事实、assistant 输出文本、截断和下一轮 LLM 上下文归 TalkRuntime。
- 本文描述的是 TalkRuntime 的理想扩展模型，不是 `docs/core/talk-runtime.md` 中首版只定义入站契约的现状。
- TTS 和播放是两个不同阶段，不能把 TTS promise 链当作播放队列。
- 待播队列只有一个取出者：playback worker。
- 队列取出后应立即播放，不应等待下一段 TTS 或其它 producer 任务完成。
- 打断不是 fire-and-forget 的异步副作用，而是进入 `interruptQueue` 的事务。
- 待播队列是否允许取出，只看 interrupt gate 是否打开；interrupt gate 打开的条件是 `interruptQueue` 为空。
- ASR final 只更新对应的 interrupt item；interrupt item ready 后先出队，再提交给 runtime。
- ASR final 超时从用户结束输入后开始计时，不从打断发生时开始计时。
- 不能因为某个 chunk 已进入 TTS 或播放队列就启动下一轮 LLM；下一轮 LLM 只能由稳定用户输入、session start 或明确续写策略触发。

## 部件

理想实现分三层：

- TalkRuntime：Core 侧实时会话事实存储、assistant output ledger、chunk claim、interrupt 截断和下一轮 LLM 上下文构筑。
- Voice Call Runtime：单次通话内的 worker 编排层，拥有 `playbackQueue`、`interruptQueue`、active TTS tasks、ASR stream 和 WebRTC/网页状态。
- 平台/网页层：负责 WebRTC 信令、浏览器音频采集、按钮/VAD 状态和 UI 状态展示，不直接写 TalkRuntime 的事实表。

边界规则：

- voice call 不保存长期会话事实；它只保存可丢弃的通话内队列和 worker 状态。
- TalkRuntime 不直接播放音频、不调用具体 TTS/ASR provider、不持有 WebRTC peer。
- Agent loop 不读取 voice call 队列；它只通过 TalkRuntime 读写同一个 talk session。
- ASR final、timeout 和 manual/barge-in 都必须转换成 TalkRuntime 可记录的稳定事件或控制事件。
- 当前 `docs/core/talk-runtime.md` 的 `TalkRuntimeIngress` 是首版入站口；本文中的 `claimReadyOutputChunk`、`interruptOutput` 和 assistant output ledger 是后续必须补齐的扩展接口。

## 并行与串行边界

voice call 中允许并行的是 producer、网络请求和独立 worker；必须串行的是状态提交、播放取出、interrupt 出队和 runtime 会话构筑。

### 必须串行

以下流程必须串行执行：

- Playback worker 取出 playbackQueue。
- 单个 playback item 的 frame 播放。
- interruptQueue 队头出队。
- 同一个 interrupt item 的 runtime interrupt 提交。
- 同一个 interrupt item 的 final text 提交。
- TalkRuntime 对同一个 session 的 message/output 截断和下一轮上下文构筑。
- Agent loop 对同一个 talk session 的 LLM call。
- 同一个 talk session 的 assistant output sequence 分配。

串行约束：

- 同一时间只能有一个 playing item。
- interrupt gate 关闭时，playback worker 不得取出新的 playback item。
- interrupt gate 关闭时，runtime output pump 不得 claim 新 chunk。
- interrupt item 必须按队列顺序出队。
- 队头 item 未 ready 时，后面的 ready item 不能越过它提交 runtime。
- item 出队前必须已经 `runtimeReady`；`runtimeReady` 表示旧 output/chunk、active TTS 和当前播放队列已经完成截断、取消或清理。

### 可以并行

以下流程可以并行执行：

- LLM stream delta 写入 TalkRuntime，与 voice call 播放已 claim 音频并行。
- TalkRuntime chunk claim 与当前 playback item 播放并行，前提是 interrupt gate 打开。
- 多个 TTS producer task 可以并行准备后续音频，前提是结果仍按 playbackQueue 顺序播放。
- ASR 音频输入与当前 TTS/playback 并行。
- runtime interrupt 与 ASR final 等待并行；二者都 ready 后才能提交 final text。
- TTS request 返回可以晚于 interrupt，但返回后必须检查 task 是否 aborted。

并行约束：

- 并行 producer 只能 append，不能直接播放。
- 并行 TTS 结果不能越过 playbackQueue 顺序播放。
- 并行 ASR final 不能绕过 interruptQueue 直接提交 runtime。
- 旧 interrupt 的 callback 只能更新旧 item，不能恢复全局播放状态。
- LLM stream 可以领先播放，但不能绕过 TalkRuntime 的输出顺序和中断截断。

### Worker 总览

| Worker | 并发数量 | 输入 | 输出 | 是否可并行 |
| --- | --- | --- | --- | --- |
| Agent Loop Worker | 每 session 最多 1 个 | TalkRuntime session | assistant output delta | 不可同 session 并行 |
| Runtime Output Pump | 每 call 1 个 | ready output chunk | TTS producer task | 可与 playback 并行 |
| TTS Producer | 多个 task | text chunk | playback item frames | 可并行，但只 append |
| Playback Worker | 每 call 1 个 | playbackQueue | outbound audio frame | 不可并行 |
| ASR Worker | 每 call 1 个当前 stream | inbound audio | partial/final transcript | 可与播放并行 |
| Interrupt Queue Drain | 每 call 1 个逻辑队列 | ready interrupt item | runtime final input | 不可并行 |

### TalkRuntime

TalkRuntime 是语音通话的实时事实存储、assistant output ledger 和 agent loop 协调层。它应是 `MessageRuntime` 的低延迟实时对话兄弟层，但本文要求的出站 ledger、chunk claim 和 interrupt 截断属于理想扩展接口，不能假设首版入站-only TalkRuntime 已经具备。

职责：

- open/close talk session。
- 接收 LLM 流式 delta，保存 output/message index 和 char index。
- 维护 assistant output ledger、输出缓存和可 claim chunk。
- 收到 interrupt 时，根据 voice call 提供的 output id、char index、前后文定位断点。
- 将断点及之后内容从主输出移除，存入 discard 表。
- 取消断点之后的 assistant outputs/chunks。
- 等待 voice call 提交 final user text。
- final user text 到达后，构筑下一轮 LLM 上下文。
- 给同一 session 的 input/output/interrupt 分配单调 sequence，保证重启恢复和后台排查可以重放事实。
- 将已 claim、已播放、被截断、被取消的 chunk 状态持久化或至少写入可追踪事件日志。

不属于 TalkRuntime 的职责：

- WebRTC 信令和浏览器 peer 管理。
- 调用具体 TTS/ASR provider。
- 持有 playback queue 或 frame queue。
- 根据 promise finally 恢复播放状态。

### Agent Loop Worker

Agent loop worker 由 TalkRuntime 发起。

职责：

- 在 runtime 空闲时启动 LLM call。
- 流式读取 LLM delta。
- 每条 streaming assistant message 写入 TalkRuntime，包含 message/output id、message index、char index。
- 收到 runtime interrupt 后取消当前 LLM call。
- 不重新拼接 prompt 前缀；只替换会话尾部 message。

启动条件：

- session open。
- `interruptQueue` 已清空。
- TalkRuntime 输出缓存为空。
- 没有 streaming output、pending chunk、ready chunk。
- 存在可触发下一轮的稳定输入或 session start 事件。

禁止条件：

- 不能仅因为某个 chunk 已经被 voice call claim、进入 TTS 队列或播放完成就启动下一轮。
- 同一 session 已有 LLM call streaming 时，不得并发启动第二个 LLM call。
- interrupt runtime 部分未完成时，不得构筑下一轮上下文。

### Runtime Output Pump

Runtime output pump 是 voice call 内部 worker。

职责：

- 在 interrupt gate 打开时轮询 `TalkRuntime.claimReadyOutputChunk`。
- claim 到 chunk 后启动 TTS producer。
- TTS producer 首帧或首段可播放内容入队后，更新 chunk 的 voice-call 状态，例如 `tts_ready`。
- 不等待当前播放结束再 claim 下一段。
- 对同一 output 的 chunk 按 TalkRuntime sequence claim；可以预取后续 chunk，但不能越过已取消或未 ready 的 chunk。

暂停条件：

- interrupt gate 关闭时不 claim 新 chunk。
- TalkRuntime 返回 no-ready-chunk 时休眠或等待通知，不自造空 chunk。

### TTS Producer

TTS producer 只负责生成可播放音频并写入待播队列。

职责：

- 接收 runtime chunk 原文和 output/char index 信息。
- 对文本做 TTS 过滤，例如括号内容不进入 TTS，但原文仍由 runtime 保存。
- 调用 TTS。
- 将生成的 audio frames 写入 playback item 的 frame queue。
- 第一段 audio frames ready 后立即入队，不等待下一段 TTS 完成。
- 后续分句 TTS 可以预取，但不得阻塞已 ready 内容播放。

中断要求：

- 每个 TTS producer task 必须登记到 active TTS task 集合。
- interrupt 时所有 active TTS task 标记 abort。
- 已发出的 TTS 请求即使底层无法硬取消，返回后也不得 decode、push frame 或播放。

### Playback Queue

Playback queue 是待播放内容队列。

队列 item 应包含：

- output id。
- chunk id。
- 原文 text。
- TTS 过滤后的 speak text。
- outputStartCharIndex / outputEndCharIndex。
- speechSpans：TTS 过滤后文本到原文 char range 的映射。
- frame queue。
- totalMs。
- playedMs。
- status：queued / playing / played / interrupted / failed。

规则：

- producer 从后面追加。
- playback worker 从前面取出。
- 只有 playback worker 可以将 queued item 变为 playing。
- interrupt gate 关闭时禁止取出。
- interrupt 时不先清快照；先停止取出并中断当前播放，再清实际队列。
- breakpoint 不能只用 `playedMs / totalMs` 直接映射到原文；必须结合 `speechSpans`，避免括号内容、静音、标点过滤后截断错位。

### Playback Worker

Playback worker 是唯一播放消费者。

职责：

- 循环检查是否可以取出 playback item。
- 取出条件：
  - call 未关闭。
  - interrupt gate 打开。
  - 当前没有 playing item。
  - playbackQueue 有 queued item 且其 frame queue 有可播放内容。
- 取出后立即写 outbound audio frame。
- 播放时持续更新 `playedMs`、`totalMs`、framesWritten。
- 如果 TTS provider 能返回音素、字词或分段 timing，应保存到当前 item，用于更精确的 breakpoint。
- 当前播放被 interrupt 时立即停止写 frame。

### Interrupt Queue

interruptQueue 是 voice call 打断事务队列。

每个 interrupt item 应包含：

- interruptId。
- reason。
- targetOutputId。
- targetChunkId。
- asrStreamId。
- breakpointCharIndex。
- breakpointContext。
- runtimeReady。
- finalReady。
- finalText。
- finalError。
- finalTimer。

规则：

- 打断发生时立即入队。
- interrupt gate 关闭时 playback worker 停止取出。
- interrupt gate 关闭时 runtime output pump 停止 claim 新 chunk。
- ASR final 只更新匹配的 interrupt item。
- item 满足 `runtimeReady && finalReady` 后，先从队列出队，再提交 final text 给 runtime。
- item 出队后如果队列为空，playback worker 和 runtime output pump 可以恢复；这个恢复是安全的，前提是 `runtimeReady` 已经原子完成旧 output/chunk 的截断、取消和当前播放队列清理。
- final text 提交仍必须按 interrupt item 顺序串行执行，不能与同一 session 的其它 stable input 提交乱序。

### ASR Worker

ASR worker 负责用户输入转文本。

职责：

- voice call 收到用户音频后写入当前 ASR stream。
- 用户结束输入时发送 ASR end。
- ASR final 返回后，根据 streamId 绑定 interrupt item。
- 如果无法精确匹配 streamId，但只有一个 pending interrupt，可以绑定该 interrupt。
- 如果没有 pending interrupt，则作为普通 user input 提交 runtime。
- 普通 user input 提交也必须经过同一 session 的 stable input commit 序列；如果 `finalCommitInFlight` 存在，应排队等待，不能越过 interrupt final text。

超时规则：

- ASR final timeout 从发送 ASR end 开始计时。
- 不能从 interrupt 发生时开始计时，因为用户可能还在说话。
- timeout 后，如果 interrupt item 仍未 finalReady，则 finalText 使用 `-杂音-`，finalError 标为 `asr_timeout`。
- timeout item 仍按正常 interrupt item 流程出队并提交 runtime。

## LLM -> User 流程

1. 用户点击 call。
2. voice call 显示等待接通。
3. voice call 调用 `TalkRuntime.openSession`。
4. TalkRuntime 启动 agent loop。
5. LLM stream delta 写入 TalkRuntime。
6. TalkRuntime 按特殊字符切 chunk，保留切分字符。
7. TalkRuntime 缓冲达到阈值或 output finish 后，将 chunk 标记 ready。
8. Runtime output pump 在 interrupt gate 打开时 claim ready chunk。
9. Runtime output pump 启动 TTS producer。
10. TTS producer 第一段 audio frames ready 后写入 playback queue。
11. 如果是首段语音，voice call 标记已接通，并可做首段固定延迟。
12. Playback worker 发现 interrupt gate 打开，立即取出并播放。
13. TTS producer 可以继续生成后续分句，追加到同一 item 或后续 item。
14. chunk 已进入 TTS/播放队列后，voice call 只更新该 chunk 的播放侧状态；是否继续同一 assistant output 或启动下一轮，只由 TalkRuntime 根据 LLM stream、稳定用户输入和 session 状态决定。

## User -> LLM 正常输入流程

1. 用户开始说话。
2. voice call 将音频写入 ASR stream。
3. 用户结束说话。
4. voice call 发送 ASR end。
5. 启动 ASR final timeout。
6. ASR final 返回。
7. 如果没有 pending interrupt，voice call 直接向 TalkRuntime 提交 `audio.transcript.final`。
8. TalkRuntime 保存 user segment。
9. 如果 runtime 空闲，启动下一轮 agent loop。

## User -> LLM 打断流程

1. 用户说话信号持续达到 barge-in 条件。
2. voice call 找到当前 target：
   - 优先当前 playing item。
   - 否则使用 queued 的下一段 item。
3. voice call 创建 interrupt item 并插入 `interruptQueue`。
4. playback worker 因 interrupt gate 关闭停止取出。
5. runtime output pump 因 interrupt gate 关闭停止 claim。
6. 如果存在当前 playing item，voice call 立即停止当前播放。
7. voice call 根据当前播放的 `playedMs / totalMs` 估算本 chunk 内断点。
8. voice call 结合 chunk 的 outputStartCharIndex 计算 output char index，并生成前后文。
9. voice call abort 所有 active TTS producer task。
10. voice call 清当前 frame queue 和实际 playbackQueue。
11. voice call 调用 `TalkRuntime.interruptOutput`：
    - targetOutputId。
    - breakpointCharIndex。
    - breakpointContext。
    - elapsedMs / totalMs。
    - 段间打断时设置 omitAssistantMessage。
12. TalkRuntime 截断当前 output。
13. TalkRuntime 将断点及之后内容写入 discard。
14. TalkRuntime 取消断点之后的 outputs/chunks。
15. TalkRuntime 取消当前 LLM stream。
16. runtime interrupt 完成后，interrupt item 标记 runtimeReady。
17. 用户结束输入时，voice call 发送 ASR end，并启动 ASR final timeout。
18. ASR final 返回后，interrupt item 写入 finalText 并标记 finalReady。
19. 如果 ASR final timeout，interrupt item 写入 `-杂音-` 并标记 finalReady。
20. 当队头 item 满足 `runtimeReady && finalReady`：
    - 先从 interruptQueue 出队。
    - 再将 final text 作为该 interrupt 后的稳定用户输入提交给 TalkRuntime。
21. TalkRuntime 保存 user segment。
22. TalkRuntime 组装下一轮上下文。
23. 如果 runtime 空闲，启动下一轮 agent loop。
24. interruptQueue 清空后，playback worker 和 runtime output pump 恢复工作。

## 段间打断

段间打断指没有当前 playing item，但下一段已经 queued。

处理规则：

- target 使用 queued 的下一段 output。
- breakpointCharIndex 使用该 output 起点。
- `omitAssistantMessage = true`。
- TalkRuntime 将该 output 标记 cancelled。
- 该 output 全文写入 discard。
- 下一轮上下文不包含该 output，也不包含空的 `...` assistant。

## 连续打断

连续打断必须通过 interruptQueue 处理，不能靠全局 boolean 或旧 promise finally 恢复状态。

规则：

- 每次打断创建独立 interrupt item。
- 旧 interrupt 的 runtime callback 只能更新自己的 item。
- 旧 interrupt 的 timeout 只能更新自己的 item。
- 旧 interrupt 不得恢复新 interrupt 的播放/claim 状态。
- 如果多个 interrupt pending，ASR final 优先按 streamId 匹配。
- 如果 streamId 不可靠，且只有一个 pending interrupt，可以绑定唯一 pending item。
- 多个 pending 且无法匹配时，不能随意提交，应记录错误并等待 timeout。

## 超时与失败

### ASR final timeout

- 从 ASR end 发出后开始计时。
- timeout 文本为 `-杂音-`。
- timeout 仍作为 user input 提交 runtime。
- 不能在用户仍在说话时触发 timeout。

### TTS 失败

- 当前 TTS item 标记 failed。
- 不影响 runtime 已保存的 assistant output。
- playback worker 跳过 failed item。

### Runtime interrupt 失败

- interrupt item 不应静默丢失。
- 应记录错误状态。
- 为避免播放死锁，可以按明确策略 fail-open 或 fail-closed，但必须有日志和状态。

## 验收标准

- TTS 第一段生成完成后立即播放，不等待下一段 TTS 完成。
- interrupt 后当前播放立即停止。
- interrupt 后已启动但未返回的 TTS 结果不能再进入播放队列。
- interrupt gate 关闭时 runtime output pump 不 claim 新 chunk。
- interrupt gate 关闭时 playback worker 不取出待播 item。
- ASR final 正常返回时，不应被 `-杂音-` 替代。
- 用户说话时间超过 ASR timeout 时，不应触发 timeout；timeout 只能从 ASR end 后开始。
- ASR final 丢失时，最终以 `-杂音-` 出队，不死锁。
- 三次正常 ASR final 应产生三次 interruptQueue 出队或三次普通 user input，不应只出一次 `-杂音-`。
- 段间打断不应把下一段 assistant 留在上下文。
- 连续打断不会被旧 interrupt 的 callback 覆盖。

## 数据格式

本节定义理想实现中的输入输出结构。字段名可以按代码风格调整，但语义不能变。

### Web -> Server 信令消息

网页通过 WebSocket 或等价信令通道发送消息。

#### call.start

```json
{
  "type": "call.start",
  "callId": "browser-generated-call-id",
  "userId": "browser-user",
  "offerSdp": "..."
}
```

输出：

```json
{
  "type": "call.answer",
  "callId": "browser-generated-call-id",
  "answerSdp": "...",
  "talkSessionId": "webrtc_voice:browser-generated-call-id"
}
```

#### ice.candidate

```json
{
  "type": "ice.candidate",
  "candidate": {}
}
```

#### audio.chunk

```json
{
  "type": "audio.chunk",
  "streamId": "asr-call-1-0",
  "sequence": 12,
  "bytes": "base64-pcm-or-webm",
  "timing": {
    "startedAtMs": 1200,
    "durationMs": 100
  }
}
```

#### audio.end

```json
{
  "type": "audio.end",
  "streamId": "asr-call-1-0"
}
```

#### speech.active

网页 push-to-talk 或 VAD 状态变化。

```json
{
  "type": "speech.active",
  "active": true
}
```

```json
{
  "type": "speech.active",
  "active": false
}
```

规则：

- `active: true` 可以触发 barge-in。
- `active: false` 触发 ASR end，并从此刻开始 ASR final timeout。
- 连续 `active: true` 不应被简单去重；如果有新的 playing/queued target，仍可触发新的 interrupt。

#### call.interrupt

手动打断。

```json
{
  "type": "call.interrupt",
  "reason": "manual"
}
```

#### call.hangup

```json
{
  "type": "call.hangup",
  "reason": "user_hangup"
}
```

### Server -> Web 状态消息

#### call.status

```json
{
  "type": "call.status",
  "state": "voice_call.waiting",
  "detail": "webrtc_voice:call-1"
}
```

常见 state：

- `voice_call.waiting`：等待 runtime/首段 TTS。
- `voice_call.connected`：第一条语音 ready，通话接通。
- `talk_runtime.open`：session 已打开。
- `talk_runtime.output_claimed`：claim 到 runtime chunk。
- `tts.output_text`：当前 TTS 原文。
- `tts.part.synthesizing`：分句 TTS 开始。
- `tts.part.synthesized`：分句 TTS 完成。
- `tts.queue.ready`：音频 frames 已入待播队列。
- `tts.played`：播放完成。
- `tts.interrupted`：播放被打断。
- `tts.barge_in`：用户打断播放。
- `talk_runtime.interrupt`：已通知 runtime interrupt。
- `talk_runtime.interrupt.final_ready`：ASR final 已写入 interrupt item。
- `talk_runtime.interrupt.asr_timeout`：ASR final timeout，以 `-杂音-` 提交。
- `asr.partial`：ASR partial。
- `audio.transcript.final`：ASR final 普通提交。

#### assistant.output_text

网页测试页显示当前播放内容原文。

```json
{
  "type": "assistant.output_text",
  "outputId": "output-123",
  "chunkId": "chunk-456",
  "text": "現在再生予定または再生中の原文。"
}
```

#### user.input_text

网页测试页显示用户最终输入。

```json
{
  "type": "user.input_text",
  "streamId": "asr-call-1-0",
  "text": "用户说话文本"
}
```

#### interrupt.status

```json
{
  "type": "interrupt.status",
  "interruptId": "interrupt-1",
  "state": "queued",
  "targetOutputId": "output-123"
}
```

常见 state：

- `queued`：interrupt item 已入队。
- `runtime_ready`：runtime 截断完成。
- `final_ready`：ASR final 已到。
- `asr_timeout`：ASR final 超时，使用 `-杂音-`。
- `drained`：item 已出队并提交 runtime。

## 内部队列格式

### VoiceCallState

```ts
type StableInputCommit = {
  commitId: string;
  kind: "interrupt_final" | "audio_transcript_final" | "text_final";
  streamId?: string;
  interruptId?: string;
  text: string;
  occurredAt: string;
  occurredAtUtc?: string;
};

type VoiceCallState = {
  callId: string;
  talkSessionId: string;
  status: "idle" | "opening" | "connected" | "closing" | "closed" | "failed";
  playbackQueue: PlaybackItem[];
  currentPlayingItem?: PlaybackItem;
  interruptQueue: InterruptItem[];
  finalCommitInFlight?: string;
  stableInputCommitQueue: StableInputCommit[];
  activeTtsTasks: Map<string, ActiveTtsTask>;
};
```

派生规则：

```ts
const interruptGateOpen = state.interruptQueue.length === 0;
```

规则：

- playback worker 和 runtime output pump 只能读取 `interruptGateOpen` 的结果，不各自维护一套暂停 boolean。
- `finalCommitInFlight` 只用于同一 session 的 stable input 提交排序，不参与 playback/pump gate。
- `stableInputCommitQueue` 保存等待提交 TalkRuntime 的 interrupt final 或普通 ASR final，保证同一 session 用户输入顺序稳定。
- final text 提交成功或明确失败后必须清除 `finalCommitInFlight`，否则会阻塞后续用户输入提交。
- call close 时必须停止 playback worker、abort active TTS tasks、结束 ASR stream，并调用 TalkRuntime closeSession。

### PlaybackItem

```ts
type SpeechSpan = {
  speakStartCharIndex: number;
  speakEndCharIndex: number;
  outputStartCharIndex: number;
  outputEndCharIndex: number;
  startMs?: number;
  endMs?: number;
};

type PlaybackItem = {
  outputId: string;
  chunkId: string;
  originalText: string;
  speakText: string;
  outputStartCharIndex: number;
  outputEndCharIndex: number;
  speechSpans: SpeechSpan[];
  frameQueue: AudioFrameQueue;
  status: "queued" | "playing" | "played" | "interrupted" | "failed";
  framesWritten: number;
  playedMs: number;
  totalMs: number;
  playbackAborted: boolean;
};
```

输入来源：

- Runtime Output Pump claim 的 chunk。
- TTS Producer 生成的 audio frames。

输出去向：

- Playback Worker。
- Interrupt breakpoint 计算。

`speechSpans` 规则：

- 每个 span 记录一段实际进入 TTS 的 speak text 对应的原文 char range。
- 括号内容、不可读控制符或被过滤文本不进入 speak text，但必须在原文 range 中可定位。
- provider timing 可选；没有 timing 时才退回到 span 内按比例估算。

### InterruptItem

```ts
type InterruptItem = {
  interruptId: string;
  reason: "barge_in" | "manual" | "network" | "unknown";
  targetOutputId?: string;
  targetChunkId?: string;
  asrStreamId?: string;
  breakpointCharIndex?: number;
  breakpointContext?: {
    beforeText?: string;
    afterText?: string;
  };
  elapsedMs?: number;
  totalMs?: number;
  state: "queued" | "runtime_ready" | "final_ready" | "asr_timeout" | "drained" | "failed";
  runtimeReady: boolean;
  finalReady: boolean;
  finalText?: string;
  finalError?: "asr_timeout" | "asr_error";
  finalTimer?: unknown;
};
```

状态流转：

```text
queued
  -> runtime_ready
  -> final_ready
  -> drained
```

或：

```text
queued
  -> final_ready
  -> runtime_ready
  -> drained
```

ASR timeout 流转：

```text
queued
  -> runtime_ready
  -> asr_timeout
  -> drained
```

失败流转：

```text
queued
  -> failed
```

或：

```text
runtime_ready
  -> failed
```

注意：

- `runtimeReady` 和 `finalReady` 可以并行完成。
- 出队必须发生在提交 runtime final text 之前；出队安全依赖 `runtimeReady` 已经取消旧 output/chunk。
- timeout final text 为 `-杂音-`。
- `state` 是调试和 UI 用的可读状态；真正出队条件仍是队头 item 的 `runtimeReady && finalReady`。

### ActiveTtsTask

```ts
type ActiveTtsTask = {
  taskId: string;
  outputId: string;
  chunkId: string;
  aborted: boolean;
  abortController?: AbortController;
};
```

规则：

- TTS producer 启动时登记。
- TTS producer 完成或失败时移除。
- interrupt 时全部标记 aborted。
- 如果底层 TTS 支持 abort signal，必须调用 abort。
- 如果底层 TTS 不支持硬取消，返回后也必须检查 `aborted`，不得继续 decode/push/play。

## TalkRuntime 接口格式

### openSession

```ts
TalkRuntime.openSession({
  sessionId: "webrtc_voice:call-1",
  source: {
    plugin: "webrtc_voice",
    accountId: "main",
    channelId: "call-1",
    userId: "browser-user"
  },
  occurredAt: "2026-06-07T04:00:00.000+09:00",
  occurredAtUtc: "2026-06-06T19:00:00.000Z",
  metadata: {
    callId: "call-1",
    language: "ja",
    sampleRate: 16000,
    format: "pcm_s16le"
  }
});
```

### claimReadyOutputChunk

输出：

```ts
{
  sessionId: "webrtc_voice:call-1",
  outputId: "output-1",
  chunkId: "chunk-1",
  text: "逆賊、聞こえているのか。",
  startCharIndex: 0,
  endCharIndex: 13,
  outputTextLength: 13
}
```

### interruptOutput

输入：

```ts
TalkRuntime.interruptOutput({
  sessionId: "webrtc_voice:call-1",
  outputId: "output-1",
  reason: "barge_in",
  elapsedMs: 1200,
  totalMs: 3000,
  breakpointCharIndex: 8,
  breakpointContext: {
    beforeText: "聞こえて",
    afterText: "いるのか"
  },
  omitAssistantMessage: false
});
```

输出语义：

- 截断 output 到 breakpoint。
- breakpoint 后内容写 discard。
- 取消后续 outputs/chunks。
- 取消当前 LLM stream。
- 标记 interrupt item 的 `runtimeReady = true`。

### ingestInput

普通 ASR final：

```ts
TalkRuntime.ingestInput({
  kind: "audio.transcript.final",
  sessionId: "webrtc_voice:call-1",
  source: {
    plugin: "webrtc_voice",
    accountId: "main",
    channelId: "call-1",
    userId: "browser-user"
  },
  sequence: 3,
  occurredAt: "2026-06-07T04:19:21.000+09:00",
  occurredAtUtc: "2026-06-06T19:19:21.000Z",
  payload: {
    kind: "transcript",
    text: "西安爱丽丝，我现在测试就是中断你的说话，然后我说话这样子。",
    language: "zh",
    segmentId: "asr-call-1-0"
  },
  raw: {}
});
```

ASR timeout：

```ts
TalkRuntime.ingestInput({
  kind: "audio.transcript.final",
  sessionId: "webrtc_voice:call-1",
  source: {
    plugin: "webrtc_voice",
    accountId: "main",
    channelId: "call-1",
    userId: "browser-user"
  },
  sequence: 4,
  occurredAt: "2026-06-07T04:19:30.000+09:00",
  occurredAtUtc: "2026-06-06T19:19:30.000Z",
  payload: {
    kind: "transcript",
    text: "-杂音-",
    language: "zh",
    segmentId: "asr-call-1-1",
    asrTimedOut: true
  }
});
```

## 网页交互格式

测试页应至少显示两个框：

- 当前 assistant 原文：显示正在播放或刚进入播放队列的原文。
- 用户输入：显示 ASR final 文本，包括正常文本和 `-杂音-`。

### 页面控件

- Call：建立 WebRTC 和 TalkRuntime session。
- Hold to talk：按下发送 `speech.active true`，松开发送 `speech.active false`。
- Interrupt voice：发送手动 `call.interrupt`。
- Hang up：发送 `call.hangup` 并 close session。
- Test voice：本地测试 TTS/playback，不应写入 TalkRuntime 正式会话。

### 页面状态流

```text
idle
  -> waiting_call_answer
  -> waiting_runtime_first_output
  -> connected
  -> speaking
  -> interrupted
  -> waiting_asr_final
  -> connected
  -> hanging_up
  -> closed
```

### 页面显示规则

- 收到 `assistant.output_text`，覆盖 assistant 原文框。
- 收到 `tts.output_text`，也可以覆盖 assistant 原文框，但应标明是原文，不是过滤后文本。
- 收到 `user.input_text`，追加到用户输入框。
- 收到 `talk_runtime.interrupt.asr_timeout`，用户输入框追加 `-杂音-`。
- 收到 `voice_call.connected` 后，按钮状态从等待接通切到已接通。
- Hang up 后禁用 Hold to talk 和 Interrupt voice。

### 三次打断的期望页面行为

如果用户连续三次打断并每次都有正常 ASR final：

```text
[04:19:21] 西安爱丽丝，我现在测试就是中断你的说话，然后我说话这样子。
[04:19:27] 然后我想试的，还有就是这种多次的终端。
[04:19:30] 非常非常多次的。
```

期望：

- interruptQueue 至少完成三次出队，或没有 pending interrupt 时作为三次普通 user input 提交。
- 用户输入框显示三条正常文本。
- 不应只显示一次 `-杂音-`。
- `-杂音-` 只应在某次 ASR end 后等待 final 超时才出现。
