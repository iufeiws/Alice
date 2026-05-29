# MOSS-TTS-Nano ONNX service

Lightweight local HTTP wrapper for the MOSS-TTS-Nano ONNX CPU model.

## Install runtime deps

```bash
npm run tts:moss:install
```

The Node voice synthesizer uses the npm `ffmpeg-static` package by default because Feishu uploads audio as opus. Set `MOSS_TTS_FFMPEG_COMMAND` only if you want to use a custom ffmpeg binary.

## Model files

Put the ONNX browser assets under:

```text
assets/tts/moss-onnx/models
```

The directory must contain `browser_poc_manifest.json` and the referenced TTS/tokenizer/codec files from:

- `OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX`
- `OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX`

The service does not download models at runtime.

## Reference audio

The first implementation accepts fixed voice-clone reference audio from:

```text
assets/tts/references/alice/reference.wav
```

Use 16-bit PCM WAV at the codec sample rate, normally 48 kHz. Mono is duplicated to stereo when the model expects two channels.

## Alice config

```env
MOSS_TTS_PYTHON_COMMAND=.conda-moss/bin/python
MOSS_TTS_MODEL_DIR=assets/tts/moss-onnx/models
MOSS_TTS_REFERENCE_AUDIO=assets/tts/references/alice/reference.wav
MOSS_TTS_OUTPUT_DIR=assets/generated/tts
MOSS_TTS_IDLE_SHUTDOWN_MS=900000
# Optional; defaults to npm ffmpeg-static
# MOSS_TTS_FFMPEG_COMMAND=/usr/bin/ffmpeg
```

Alice starts the service on the first `send_chat` voice request and shuts down only the process it started after the idle timeout.

For manual debugging:

```bash
npm run tts:moss:start
```
