# WebRTC Voice Playback Boundary

- Playback consumer state is local to the WebRTC voice call.
- The consumer must not notify other modules that playback is complete.
- Other modules must not wait for playback completion before producing more output.
- `playReplyText()` is a producer path: Talk chunk text -> TTS -> encoder -> playback consumer queue.
- The call-level playback consumer is the only owner of outbound playback state, playback text cache, played timing, and interrupt breakpoint calculation.
- TalkRuntime only needs interrupt or breakpoint notifications from the voice path. It must not receive or depend on played notifications from the playback consumer.
- `beforeFirstPlayback` means exactly before the first real frame is pushed to outbound playback. Do not add long sleeps or playback-completion waits there. If the live environment needs a startup buffer, it may be a short 100ms buffer for the first real playback of the call only, not for every TalkRuntime chunk.
- Silence frames are outbound keepalive only. They must not be inserted between available real audio frames, and they must not gate TalkRuntime output production.
