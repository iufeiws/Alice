# TTS Plugin

`src/channels/tts` is the canonical outbound voice synthesis plugin.

It owns translation-before-TTS, Genie/MOSS synthesizer creation, streaming audio events, and the preset settings used by `send_chat` voice output and WebRTC voice playback. `tools/messaging` should only call an injected `VoiceSynthesizer`.

## Runtime Boundary

- Plugin id: `tts`
- Admin id: `tts`
- Display name: `TTS`
- Config path: `config/plugin/tts/config.json`
- Canonical asset root: `assets/tts/preset/`
- Legacy config fallback: `src/channels/tts/config.json`

The original outgoing text remains the `send_chat` transcript and persisted message content. Translation output is transient and is used only for synthesis.

## Config Shape

```json
{
  "enabled": true,
  "remote": {
    "enabled": true,
    "baseURL": "http://192.168.0.103:8767",
    "localFallbackEnabled": false
  },
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

- `remote.enabled`: whether to try the LAN Genie TTS service before local Genie fallback.
- `remote.baseURL`: LAN Genie TTS IP or base URL, for example `192.168.0.103` or `http://192.168.0.103:8767`. Bare IP/host values default to port `8767`.
- `remote.localFallbackEnabled`: whether a non-local Genie route may start local Genie after it fails. Disable this to keep API and remote routes from waking local Genie.
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

Legacy config files under `src/channels/tts/config.json` are still read as migration input when the canonical config is missing. Legacy flat fields such as `translationEnabled`, `apiPresetName`, `prompt`, `voice.language`, `voice.modelDir`, `voice.referenceAudio`, and `voice.referenceText` are also still accepted.

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
- `remote.enabled`: enables the remote Genie TTS service.
- `remote.baseURL`: remote Genie TTS IP or base URL.
- `targetRoute`: readonly `send_chat.voice.before_tts`.
- `persistTranslation`: readonly note that translations are transient.
- `Save Common Settings` saves only this section.

This split is intentional. Preset-section saves write the edit target (`translationEditPresetName` or `voice.modelEditPresetName`). Common saves write the active runtime selectors (`translationPresetName` and `voice.modelConfigName`). A dropdown change in a preset section should never be treated as activating that preset.

The admin payload may include `translationEditPresetName`, `currentTranslation`, `voice.modelEditPresetName`, `voice.currentModel`, `newTranslationPresetName`, and `voice.newModelConfigName`. The real config file should not persist those admin-only edit-target fields.

## Remote Genie Flow

When `remote.enabled` is true, runtime first tries `remote.baseURL`. If the remote service fails before audio is produced, runtime falls back to local Genie only when `remote.localFallbackEnabled` is enabled.

Explicit remote Genie requests use the LAN upload protocol documented in `docs/remote_server/genie_tts/CLIENT_UPLOAD_FLOW.md`:

1. Send the original synthesis request to `/synthesize` with `content-type: application/json`; do not send `outputPath` for explicit remote requests.
2. Keep `modelDir` as the local model directory path derived from `assets/tts/preset/{model}/model`.
3. Put `referenceText` in the JSON body as explicit text content. Do not send a `reference.txt` path.
4. If the server returns `409` with `code: "MODEL_NOT_UPLOADED"` or `code: "REFERENCE_NOT_UPLOADED"`, zip the preset directory that contains `modelDir` and its matching `reference.*` / `reference.txt`, then POST it to the returned `uploadUrl` as `application/zip`. If the response does not include `uploadUrl`, use `/models/upload?modelDir={modelDir}`.
5. After upload succeeds, retry the original `/synthesize` request unchanged.

Local Genie still uses the older local `/stream` JSON request path, but its `referenceText` value is also resolved to text before being sent or passed to the local service process.

## Asset Migration

New assets should live under:

```text
assets/tts/preset/{preset}/model/
assets/tts/preset/{preset}/reference.*
assets/tts/preset/{preset}/reference.txt
```

Legacy assets under `assets/plugin/tts/` or `assets/tts/model/` may remain as migration sources. New admin writes should use `assets/tts/preset/`.
