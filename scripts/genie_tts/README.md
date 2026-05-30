# Genie-TTS service

Alice uses Genie-TTS as the default voice backend and falls back to MOSS when the local Genie model or reference text is unavailable.

## Install runtime deps

```bash
npm run tts:genie:install
```

This reuses `.conda-moss/bin/python` so the existing MOSS environment can host both TTS services.
Genie runtime data defaults to `assets/tts/genie/GenieData`; override it with `GENIE_TTS_DATA_DIR` for Alice-managed startup or `GENIE_DATA_DIR` when running `service.py` directly.

## Model files

Put the Genie/GPT-SoVITS ONNX character model under:

```text
assets/tts/genie/models/alice
```

The directory must contain the character ONNX model files expected by `genie_tts.load_character`.

## Reference sample

The default reference files are:

```text
assets/tts/references/alice/reference.wav
assets/tts/references/alice/reference.txt
```

Use the admin Voice Sample form to upload both the audio and the exact spoken text. If `reference.txt` is missing or empty, Alice falls back to MOSS.

## Synthesis behavior

Alice disables Genie-TTS internal sentence splitting and performs its own split on Unicode punctuation and symbol characters. The punctuation is preserved in each small piece, adjacent pieces are batched until the batched text is longer than 10 characters, a final short tail under 10 characters is folded into the previous batch, each batch is synthesized separately, and the WAV parts are concatenated with 2/3 second of silence between adjacent parts before the normal loudness check and opus conversion.

For manual debugging:

```bash
npm run tts:genie:start
```
