# Japanese Voice Translation Plugin

This plugin is a fixed send chat voice route for Japanese voice output.

When enabled, send chat voice text is translated with the plugin's fixed Flash LLM API preset and prompt before it reaches the normal TTS synthesizer. The plugin passes Japanese Genie-TTS overrides (`language: "jp"`, model dir, reference audio, reference text) on that synthesis request instead of changing global TTS config. After TTS succeeds, the existing send chat voice flow continues unchanged.

The translated text is not written to message log. The original send chat text remains the transcript and persisted chat content.

## Config

The config lives in this plugin folder:

```text
plugins/japanese-voice/config.json
```

Fields:

- `enabled`: switch for the plugin route.
- `apiPresetName`: saved API preset name. The plugin config stores only this preset reference, not API keys.
- `prompt`: fixed translation prompt. The target language is fixed here.
- `voice.referenceAudio`: plugin-owned reference audio path under `assets/plugin/japanese-voice/`.
- `voice.referenceText`: reference text stored directly in this config file.
- `voice.modelDir`: plugin-owned model directory. Folder uploads are flattened into `assets/plugin/japanese-voice/model/`.

The original text is appended directly to the final LLM message content after `prompt`.
