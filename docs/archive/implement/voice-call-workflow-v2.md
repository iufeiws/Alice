# Voice Call 工作流 V2

本文重新规整 voice call 的理想实现模型。它不描述当前占位代码，只定义后续实现应收敛到的异步泳道、队列边界和中断事务。

## 中心模型

voice call 的主路径是一条异步泳道：

```text
TalkRuntime -> TTS producer -> playbackQueue -> playback worker
```

这条泳道中：

- TalkRuntime 保存会话事实、assistant output、chunk 状态、截断和下一轮上下文。
- TTS producer 只把已 claim 的 runtime chunk 转成可播放 audio frames。
- playbackQueue 是唯一待播队列，所有准备播放或需要清理的 output chunk 都应进入这里或进入可取消的 TTS task 集合。
- playback worker 是唯一播放消费者，只有它能从 playbackQueue 取出 item 并写 outbound audio frame。

正常情况下，playbackQueue 应尽可能快地把已有可播放内容交给 playback worker。发生中断时，系统先堵住 playbackQueue 的取出端，再依次关停上游，把已产生和正在产生的任务集中到 voice call 可控集合中，然后统一 abort、清空和提交中断后的稳定输入。

## 所有权边界

### TalkRuntime

TalkRuntime 是事实层，负责：

- open/close talk session。
- 接收 agent loop 的 streaming assistant delta。
- 维护 assistant output ledger、chunk sequence 和 claim 状态。
- 提供 `claimReadyOutputChunk` 给 voice call 拉取 ready chunk。
- 在 interrupt 时截断 output、取消断点之后的 chunks/outputs，并取消当前 LLM stream。
- 接收稳定用户输入，例如 ASR final、ASR timeout、挂断占位输入。
- 构筑下一轮 LLM 上下文。

TalkRuntime 不负责：

- WebRTC signaling。
- ASR/TTS provider 调用。
- playbackQueue、frameQueue 或浏览器播放状态。
- 根据 voice call 的本地队列决定 agent loop 是否启动。

### Voice Call Runtime

Voice Call Runtime 是单次通话内的编排层，负责：

- WebRTC/网页状态。
- ASR stream 管理。
- Runtime Output Pump。
- TTS producer tasks。
- playbackQueue。
- playback worker。
- interrupt transaction。
- call close 时的截断和清理。

voice call 的本地状态可丢弃；可追溯事实必须通过 TalkRuntime 事件或 output/chunk 状态落下。

## 正常播放流程

正常流程中没有 pending interrupt：

1. TalkRuntime 打开 session，并由 TalkRuntime/agent loop 产生 assistant output delta。
2. TalkRuntime 将 output 按顺序切成 ready chunk。
3. Runtime Output Pump 调用 `claimReadyOutputChunk`。
4. Pump 为 claim 到的 chunk 启动 TTS producer。
5. TTS producer 生成第一批可播放 frames 后，把 playback item append 到 playbackQueue。
6. playback worker 发现队列可取出后立即播放，不等待后续 TTS、后续 chunk 或其它 producer 完成。
7. TTS producer 可以继续给同一 item 或后续 item 追加 frames。
8. playback worker 顺序播放 item，持续记录 `playedMs`、`totalMs`、`framesWritten`。
9. item 播放完成后更新播放侧状态；是否继续生成下一轮回复只由 TalkRuntime 根据稳定输入和 session 状态决定。

正常流程的约束：

- producer 只能 append，不能直接播放。
- playback worker 是唯一取出者。
- 同一时间只能有一个 current playing item。
- chunk 被 claim、TTS 已开始、item 已播放，都不能单独触发下一轮 LLM。
- frameQueue 永远按“之后可能还有帧”处理；不能依赖 frameQueue close 来判断 item 生命周期。

## 中断事务

中断包括 barge-in、manual interrupt、ASR failure 和 call close。它们必须进入同一个事务模型，不能靠全局 boolean 或旧 promise callback 恢复播放状态。

voice call 事务路径必须按 no-throw 设计。interrupt、ASR close、TTS abort、playback cleanup、call close 和 stable input commit 都不能用异常作为恢复语义；失败只能落到 item 状态、日志或占位稳定输入，不能打断事务，也不能让 playback gate 永久关闭。

### Interrupt Batch

interrupt 是批次屏障，不是单个全局状态，也不是逐个出队的 FIFO。短时间内可能连续发生多次 interrupt，playbackQueue 必须同时受到所有 pending interrupt 的阻塞。

```ts
type InterruptItem = {
  interruptId: string;
  reason: "barge_in" | "manual" | "asr_failure" | "call_close";
  targetOutputId?: string;
  targetChunkId?: string;
  asrStreamId?: string;
  interruptEpoch: number;
  runtimeInterrupted: boolean;
  stableInputReady: boolean;
  stableInputText?: string;
};
```

派生规则：

```ts
const playbackGateOpen = interruptBatch.items.length === 0;
```

规则：

- 每次 interrupt 都 append 一个独立 interrupt item。
- playback gate 只从 `interruptBatch.items.length` 派生；只要批次非空，playback worker 就不得取出新 playback item。
- 多个 interrupt pending 时，后一个 interrupt 会继续保持 gate 关闭，旧 interrupt 完成不得恢复播放。
- 每个 item 独立等待稳定输入。
- ASR final、ASR timeout、ASR provider failure、call close 只能更新匹配的 item。
- ASR 任意链路失败导致无法形成文本时，不阻塞 batch，而是把该 item 的稳定输入归一为 `-杂音-`。
- call close 的稳定输入为 `-已挂断-`。
- interruptBatch 是一次性清空的 barrier：批次内所有 item 都得到稳定输入后，voice call 才能一次性提交给 TalkRuntime。
- 提交完成后 interruptBatch 一次性清空。
- 只有 interruptBatch 清空后，playback gate 才能重新打开。

### 中断目标

发生中断时，voice call 找 target：

1. 优先 current playing item。
2. 没有 current playing item 时，使用 playbackQueue 中最前面的 queued item。
3. 如果仍没有 target，则创建无 target interrupt，只处理用户稳定输入或挂断输入。

breakpoint 使用 `playedMs / totalMs` 在 target chunk 内按比例估算。playback 是按 chunk 播放的，`totalMs` 指 target chunk 的音频总时长；该值在 chunk 音频生成后固定，不随后续 chunk 或其它 producer 改变。当前实现不要求 speech spans、音素 timing 或 provider timing；这些只能作为未来增强。

### 事务步骤

中断发生后按以下顺序处理：

1. 创建 interrupt item，绑定 interrupt id、reason、target output/chunk、当前 ASR stream id 和 interrupt epoch，并 append 到 interruptBatch。
2. playback gate 因 interruptBatch 非空而关闭。gate 只控制 playback worker 是否能取出新 item。
3. playback worker 立即停止当前播放，不再取出新的 playback item。
4. Runtime Output Pump 继续 claim ready chunk。
5. Pump 继续 claim 的目的不是预热，而是把 TalkRuntime 已产出的后续 output/chunk 纳入 voice call 可控集合，避免旧输出残留在 runtime 中后续误播放或误进上下文。
6. 新 claim 的 chunk 可以进入 TTS producer 或 playbackQueue，但必须带 interrupt epoch/cancellation scope，且不得被 playback worker 取出播放。
7. voice call abort 所有 active TTS tasks。底层无法硬取消时，返回后也必须检查 abort/epoch，不得 decode、push frame 或播放。
8. voice call 清 current playing item、frameQueue 和 playbackQueue，并把相关 item 标记 interrupted/cancelled。
9. voice call 调用 TalkRuntime interrupt，提交 target、breakpoint、reason 和上下文。
10. TalkRuntime 截断 target output，discard 断点之后的内容，取消后续 chunks/outputs，并停止当前 LLM stream。
11. ASR end 后启动 ASR final timeout；timeout 从用户结束输入开始计时，不从中断发生开始计时。
12. ASR final、ASR timeout、ASR provider failure 或 call close 产生稳定输入。
13. voice call 在提交稳定输入前执行事务 assert。
14. assert 通过后，voice call 将 interruptBatch 内全部稳定输入 item 作为一个批次提交给 TalkRuntime。
15. TalkRuntime 保存稳定输入，并在状态允许时构筑下一轮上下文。
16. 批次提交完成后，interruptBatch 一次性清空；只有 interruptBatch 清空后，playback gate 才能重新打开。

### 事务 assert

提交 final text 或其它稳定输入前必须满足：

- playback gate 仍关闭。
- interruptBatch 内所有 item 都已经得到稳定输入。
- current playing item 已停止。
- playbackQueue 已清空，或所有 item 已标记 interrupted/cancelled 且不可播放。
- active TTS tasks 已 abort，未返回的 task 带有不可恢复的 cancellation scope。
- Runtime Output Pump 已把当前 interrupt 范围内需要清理的 ready chunks claim 或让 TalkRuntime 标记 cancelled。
- TalkRuntime 已完成 output 截断、后续 chunk/output 取消和当前 LLM stream 停止。
- 没有旧 output/chunk 能在事务完成后重新进入可播放路径。
- 同一 session 的稳定输入提交没有乱序。

这些 assert 是架构要求。实现可以用状态机、锁、epoch、lease 或事件日志表达，但不能用 promise finally 隐式恢复播放。

## Runtime Output Pump

Runtime Output Pump 是 voice call 内部 worker。

Runtime Output Pump 永远 claim ready chunk。

正常时：

- 按 TalkRuntime chunk sequence claim ready chunk。
- 为 claim 到的 chunk 启动 TTS producer。
- 不等待当前播放结束。

中断时：

- 继续 claim ready chunk。
- 继续 claim 的目的是收拢和清理旧输出，不是降低恢复延迟。
- claim 到的 chunk 必须带 interrupt epoch/cancellation scope。
- 中断范围内的 chunk 不允许被播放。
- Pump 不得自造空 chunk；无 ready chunk 时等待通知或短暂休眠。

## TTS Producer

TTS producer 只负责生成音频并 append 到可控集合。

TTS provider、streaming 和 abort 的具体接口以 TTS 插件文档为准。本文只规定 voice call 对 TTS producer 的消费约束：所有进入 voice call 的 TTS 结果必须经过 abort/epoch 二次检查，旧 epoch 或已 abort task 的迟到 frames 一律丢弃。

规则：

- 每个 task 必须登记到 active TTS task 集合。
- 每个 task 记录 output id、chunk id、task id 和 interrupt epoch。
- 第一批 frames ready 后即可 append playback item，不等待整段文本完成。
- interrupt 后 task 必须 abort。
- task 返回时必须检查 abort/epoch；旧 epoch 的结果不得进入 frameQueue、playbackQueue 或 playback worker。
- TTS 失败只影响播放侧 item 状态；它不能让队列死锁，也不能把旧 epoch 的音频重新送入播放路径。

## Playback Queue 与 Worker

playbackQueue 是待播队列，也是中断时收拢待清理任务的地方。

Playback item 至少包含：

```ts
type PlaybackItem = {
  outputId: string;
  chunkId: string;
  originalText: string;
  speakText: string;
  outputStartCharIndex: number;
  outputEndCharIndex: number;
  frameQueue: AudioFrameQueue;
  status: "queued" | "playing" | "played" | "interrupted" | "cancelled" | "failed";
  interruptEpoch: number;
  framesWritten: number;
  playedMs: number;
  totalMs: number;
};
```

playback worker 取出条件：

- call 未关闭。
- playback gate 打开。
- 当前没有 playing item。
- playbackQueue 有 queued item。
- item 的 epoch 仍是当前可播放 epoch。
- item 当前已有可播放 frame。

规则：

- 只有 playback worker 能把 queued item 变成 playing。
- gate 关闭时只能停止取出；不要求 Runtime Output Pump 停止 claim。
- frameQueue 没有 close 语义；通话仍 open 且 item 未 cancelled/interrupted/failed 时，没有 frame 就等待后续 frame 或 item 状态变化。
- item 不依赖 producer close 判断完成；通话结束时 call runtime 被销毁，未完成 item 不需要额外本地完成态。
- 当前播放被 interrupt 时立即停止写 frame。

## 稳定输入提交

voice call 向 TalkRuntime 提交入站时，必须把当前 interruptBatch 中所有稳定输入 item 作为一个批次提交。interruptBatch 不做逐个出队；它是阻塞 playback 的批处理屏障。

TalkRuntime 侧语义是一次原子 batch commit：

```ts
type StableInputBatch = {
  sessionId: string;
  batchId: string;
  interruptEpoch: number;
  inputs: StableInputItem[];
};

type StableInputItem = {
  interruptId: string;
  sequence: number;
  reason: "barge_in" | "manual" | "asr_failure" | "call_close";
  asrStreamId?: string;
  text: string;
  occurredAt: string;
  occurredAtUtc?: string;
  targetOutputId?: string;
  targetChunkId?: string;
};
```

`inputs` 按 interrupt 发生顺序排列。连续 interrupt A、B、C 必须作为同一个 batch 的 `user:A`、`user:B`、`user:C` 按顺序进入下一轮 LLM 上下文；中间缺失会让语义不完整，提前请求只会浪费 token。

稳定输入包括：

- 正常 ASR final。
- ASR timeout，占位文本为 `-杂音-`。
- ASR provider failure，占位文本为 `-杂音-`。
- ASR 任意链路失败导致无法形成文字，占位文本为 `-杂音-`。
- call close，占位文本为 `-已挂断-`。
- manual text final。

提交规则：

- ASR final 只更新匹配 stream id 的 interrupt item。
- 多个 pending interrupt 时，后到的 final 只能更新自己的 item，不能提前提交 runtime。
- 只有队列内所有 item 都得到稳定输入后，才能批量提交给 TalkRuntime。
- batch 中某个 item 的 ASR 链路失败不阻止提交，该 item 产出 `-杂音-`。
- 批量提交完成后，interruptBatch 一次性清空。
- 普通 ASR final 如果没有 pending interrupt，也必须经过同一 session 的稳定输入提交队列。
- final commit 完成后，必须清理 in-flight 标记。

## Call Close

call close 按截断处理，不是普通资源释放。

流程：

1. 关闭 playback gate。
2. 停止 current playing item。
3. abort active TTS tasks。
4. 继续收拢或取消 TalkRuntime 已 ready 的旧 chunks。
5. 清 playbackQueue 和 frameQueue。
6. 调用 TalkRuntime interrupt/close 语义截断当前 output。
7. 向 TalkRuntime 提交稳定输入 `-已挂断-`。
8. close ASR stream、WebRTC peer 和网页状态。
9. close TalkRuntime session。

## 验收标准

- 无中断时，第一批可播放 frames ready 后立即播放。
- 无中断时，播放不等待后续 TTS 或后续 chunk。
- 中断后，playback worker 立即停止当前播放，并且不再取出新 item。
- 中断期间，Runtime Output Pump 继续 claim ready chunk，用于收拢和清理旧输出。
- 中断期间 claim/pre-TTS 的旧 output 不会被播放。
- 中断提交稳定输入前，事务 assert 必须确认 runtime、TTS、playbackQueue 和 current playing item 均已进入可清理状态。
- ASR final timeout 只从 ASR end 后开始计时。
- ASR final 正常返回时不能被 `-杂音-` 替代。
- ASR timeout 和 ASR failure 都推进同一稳定输入事务，产出 `-杂音-`，不造成死锁。
- 连续三次打断应产生三次按顺序提交的稳定输入。
- call close 会截断当前输出，并向 TalkRuntime 提交 `-已挂断-`。
