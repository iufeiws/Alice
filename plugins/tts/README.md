# TTS Plugin

`plugins/tts` is the canonical outbound voice synthesis plugin.

It owns translation-before-TTS, Genie/MOSS synthesizer creation, streaming audio events, and the preset settings used by `send_chat` voice output and WebRTC voice playback. `tools/messaging` should only call an injected `VoiceSynthesizer`.

## Runtime Boundary

- Plugin id: `tts`
- Admin id: `tts`
- Display name: `TTS`
- Config path: `config/plugin/tts/config.json`
- Canonical asset root: `assets/tts/preset/`
- Legacy config fallback: `plugins/tts/config.json`, then `plugins/japanese-voice/config.json`

The original outgoing text remains the `send_chat` transcript and persisted message content. Translation output is transient and is used only for synthesis.

## Config Shape

```json
{
  "enabled": true,
  "translationPresetName": "default",
  "translationPresets": {
    "default": {
      "translationEnabled": true,
      "apiPresetName": "voice",
      "prompt": "Translate for TTS: {{text}}"
    }
  },
  "voice": {
    "modelConfigName": "jp",
    "modelConfigs": {
      "jp": {
        "language": "jp",
        "speed": 1.15,
        "partSilenceSeconds": 0.25,
        "splitText": false
      }
    }
  }
}
```

Translation preset fields:

- `translationPresetName`: active translation preset used at runtime. It is a common setting, not the preset currently being edited in the Translation block.
- `translationPresets.{name}.translationEnabled`: whether to translate before synthesis.
- `translationPresets.{name}.apiPresetName`: LLM API preset used for translation.
- `translationPresets.{name}.prompt`: translation prompt. Prompt variables are rendered before translation only.

Model preset fields:

- `voice.modelConfigName`: active model preset used at runtime. It is a common setting, not the preset currently being edited in the Model block.
- `voice.modelConfigs.{name}.language`: Genie language, `jp`, `zh`, or `en`.
- `voice.modelConfigs.{name}.speed`: optional Genie speed multiplier, `0.5` to `2.0`.
- `voice.modelConfigs.{name}.partSilenceSeconds`: optional silence between split Genie parts, `0` to `3` seconds.
- `voice.modelConfigs.{name}.splitText`: whether Genie may split one TTS text into multiple synthesized parts.

The config does not store `modelDir`, `referenceAudio`, or `referenceText` paths. They are derived from the selected model preset name:

```text
assets/tts/preset/{name}/model/
assets/tts/preset/{name}/reference.*
assets/tts/preset/{name}/reference.txt
```

Legacy config files under `plugins/tts/config.json` and `plugins/japanese-voice/config.json` are still read as migration input when the canonical config is missing. Legacy flat fields such as `translationEnabled`, `apiPresetName`, `prompt`, `voice.language`, `voice.modelDir`, `voice.referenceAudio`, and `voice.referenceText` are also still accepted.

## Admin Settings Layout

Current admin page layout:

### Translation

- Always visible: `currentTranslation.translationEnabled` switch.
- Always visible: `translationEditPresetName` select. This chooses the preset being edited, not the runtime active preset.
- Changing `translationEditPresetName` only changes the edit target and reloads the editable fields from `translationPresets`; it does not save or activate that preset.
- `Modify` expands:
  - `newTranslationPresetName`
  - `currentTranslation.apiPresetName`
  - `currentTranslation.prompt`
- `Save Translation Preset` saves only the selected edit target preset. It does not change `translationPresetName`.

### Model

- Always visible: `voice.modelEditPresetName` select. This chooses the preset being edited, not the runtime active preset.
- Changing `voice.modelEditPresetName` only changes the edit target and reloads the editable fields from `voice.modelConfigs`; it does not save or activate that preset.
- `Modify` expands:
  - `voice.newModelConfigName`
  - `voice.currentModel.language`
  - `voice.currentModel.modelDir`
  - `voice.currentModel.referenceAudio`
  - `voice.currentModel.referenceText`
  - `voice.currentModel.speed`
  - `voice.currentModel.splitText`
  - `voice.currentModel.partSilenceSeconds`
- `Save Model Preset` saves only the selected edit target preset. It does not change `voice.modelConfigName`.

### Common

- `translationPresetName`: active translation preset used at runtime.
- `voice.modelConfigName`: active model preset used at runtime.
- `enabled`: enables the TTS plugin route.
- `targetRoute`: readonly `send_chat.voice.before_tts`.
- `persistTranslation`: readonly note that translations are transient.
- `Save Common Settings` saves only this section.

This split is intentional. Preset-section saves write the edit target (`translationEditPresetName` or `voice.modelEditPresetName`). Common saves write the active runtime selectors (`translationPresetName` and `voice.modelConfigName`). A dropdown change in a preset section should never be treated as activating that preset.

The admin payload may include `translationEditPresetName`, `currentTranslation`, `voice.modelEditPresetName`, `voice.currentModel`, `newTranslationPresetName`, and `voice.newModelConfigName`. The real config file should not persist those admin-only edit-target fields.

## Asset Migration

New assets should live under:

```text
assets/tts/preset/{preset}/model/
assets/tts/preset/{preset}/reference.*
assets/tts/preset/{preset}/reference.txt
```

Legacy assets under `assets/plugin/japanese-voice/`, `assets/plugin/tts/`, or `assets/tts/model/` may remain as migration sources. New admin writes should use `assets/tts/preset/`.
