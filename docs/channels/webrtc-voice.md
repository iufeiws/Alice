# WebRTC Voice Channel

WebRTC voice channel 位于 `src/channels/webrtc-voice`，浏览器入口由 API 路由提供。

## 当前能力

- 提供 `/voice-call` 浏览器通话页。
- 建立 WebRTC peer connection 和 outbound audio track。
- 通过 signaling WebSocket 传递控制消息。
- 支持 hold-to-talk 路径中的 `audio-chunk` 信令。
- 接入 ASR stream。
- 可注入真实 TalkRuntime，提交 final input、打断和 close。
- 从 TalkRuntime claim ready output 后调用 TTS 播放。

## TalkRuntime

注入 TalkRuntime 时，通话生命周期会调用：

- `openSession`
- `ingestInput`
- `claimReadyOutputChunk`
- `markOutputChunkPlayed`
- `interruptOutput` / `interruptLatestOutput`
- `closeSession`

未注入时，通话仍可以以 todo 状态覆盖连接和前端路径。

## 旧设计

首版设计文档已归档到 `docs/archive/design/webrtc-voice-initial-design.md`。其中“只发 todo、不接真实 TalkRuntime”和“不通过 WebSocket 发送主音频”的描述不再代表完整当前实现。
