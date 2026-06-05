# Legacy Japanese Voice Plugin Path

`plugins/japanese-voice` is now only a compatibility path.

Use `plugins/tts` for new code, config, admin routes, runtime wiring, tests, and docs. The canonical plugin id and admin id are both `tts`, and the display name is `TTS`.

Compatibility behavior:

- If `plugins/tts/config.json` is missing, Alice may read `plugins/japanese-voice/config.json`.
- Legacy flat voice fields are still accepted as migration input:
  - `voice.language`
  - `voice.modelDir`
  - `voice.referenceAudio`
  - `voice.referenceText`
- New admin saves write only `plugins/tts/config.json`.
- New model assets should live under `assets/tts/preset/{modelConfigName}/`.
- Existing files under `assets/plugin/japanese-voice/` can remain as legacy migration sources.

See `plugins/tts/README.md` for the current TTS config shape and admin settings layout.
