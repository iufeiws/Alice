# TalkRuntime 实时对话运行时

`TalkRuntime` 是实时语音/连续对话的状态运行时，当前实现位于 `src/contexts/talk-session/src/application/talk-session-runtime.ts`，存储位于 `src/contexts/talk-session/src/adapters/sqlite-talk-session-store.ts`。

它和 MessageRuntime 并列：MessageRuntime 处理离散聊天消息，TalkRuntime 处理通话会话、稳定输入、assistant 输出、chunk、播放状态和打断。

## 当前职责

- 打开和关闭 talk session。
- 接收稳定用户输入，例如 ASR final、文本 final、打断事件。
- 记录 assistant output delta，并切分为可播放 chunk。
- 供 WebRTC voice claim ready output chunk。
- 标记 chunk 已播放、前台播放空闲、agent loop ready。
- 处理 barge-in/manual interrupt，截断 output 并记录 breakpoint 上下文。
- 为 Talk loop 构筑下一轮 LLM messages。

## 存储

TalkRuntime 使用独立 SQLite 表，不直接复用聊天 `messages`：

- `talk_sessions`
- `talk_events`
- `talk_segments`
- `talk_outputs`
- `talk_output_chunks`

实时语音的临时帧、ASR delta、播放进度不应直接写入 conversation-hub 聊天消息。需要进入长期聊天历史时，应由明确投影流程写入，避免重复展示和重复归纳。

## WebRTC Voice 集成

当前 WebRTC voice 可以注入真实 TalkRuntime：

- 通话开始时调用 `openSession()`。
- ASR final 或文本 final 调用 `ingestInput()`。
- 播放输出通过 `claimReadyOutputChunk()` 或 buffered output 获取。
- 播放完成后调用 `markOutputChunkPlayed()`。
- 打断时调用 `interruptOutput()` 或 `interruptLatestOutput()`，并提交稳定输入批次。
- 挂断时调用 `closeSession()`。

没有注入 TalkRuntime 时，WebRTC voice 会以 todo 状态运行，供前端和测试覆盖连接路径。

## Loop 边界

TalkRuntime 不直接拥有 LLM function-call loop。它只暴露会话事实和下一轮消息补丁；Talk loop 负责按当前 Talk prompt profile 构筑请求并执行可见工具。
