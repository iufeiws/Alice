# channels

`channels/` 只放外部通道适配器，负责第三方 API client、webhook/signaling、消息格式转换、渠道身份绑定、出站渲染和发送。

规则：channel 不直接调用 `llm-gateway`、memory 或 agent-loop 内部实现。需要业务处理时，通过 app composition 注入 context/capability 端口。

当前 channel：

- `asr/`: speech-to-text provider adapter。
- `feishu/`: Feishu/Lark channel。
- `tts/`: outbound voice synthesis channel。
- `webrtc-voice/`: browser voice-call signaling/playback channel。
- `wechat/`: WeChat iLink channel。
