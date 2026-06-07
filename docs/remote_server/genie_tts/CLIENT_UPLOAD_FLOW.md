# Client Upload Flow

This document describes the client-side behavior for using a local client model with the LAN Genie TTS server.

The normal TTS generation request does not change. The client still sends its local model path as `modelDir`. The only new behavior is: when the server reports that this model has not been uploaded, the client zips that same local model directory, uploads it, then retries the original generation request.

## 1. Normal Generation Request

For streaming text input, keep sending the same request shape:

```powershell
$server = "http://SERVER_LAN_IP:8767"
$modelDir = "D:\client\models\alice"
$encodedModelDir = [uri]::EscapeDataString($modelDir)

@'
{"text":"第一段。"}
{"text":"第二段。"}
'@ | curl.exe -N -X POST "$server/stream-input?language=zh&modelDir=$encodedModelDir" `
  -H "content-type: application/x-ndjson" `
  --data-binary "@-" `
  --output out.pcm
```

If the server already has the uploaded cache for that `modelDir`, it streams PCM audio normally.

## 2. Missing Model Response

If the server does not have the model cache, it returns HTTP `409` with JSON:

```json
{
  "ok": false,
  "code": "MODEL_NOT_UPLOADED",
  "modelDir": "D:\\client\\models\\alice",
  "uploadUrl": "/models/upload?modelDir=D%3A%5Cclient%5Cmodels%5Calice"
}
```

The `modelDir` in this response is the same model path from the original generation request. The `uploadUrl` is the endpoint the client should use to upload that exact model.

## 3. Upload The Preset

Zip the model together with its matching reference files, then POST the zip to `uploadUrl`.

The server accepts either of these zip layouts:

```text
model/
  *.onnx
reference.wav
reference.txt
```

or:

```text
*.onnx
reference.wav
reference.txt
```

Do not upload a model that belongs to one preset and rely on the server's default reference. Explicit `modelDir` requests require the matching `reference.wav` and `reference.txt` from the same uploaded preset, unless the generation request explicitly passes `referenceAudioPath` and `referenceText`.

```powershell
$server = "http://SERVER_LAN_IP:8767"
$modelDir = "D:\client\models\alice"
$presetDir = Split-Path $modelDir -Parent
$zip = "$env:TEMP\genie-model.zip"

if (Test-Path $zip) {
  Remove-Item $zip -Force
}

Compress-Archive -Path "$presetDir\*" -DestinationPath $zip -Force

$encodedModelDir = [uri]::EscapeDataString($modelDir)
curl.exe -X POST "$server/models/upload?modelDir=$encodedModelDir" `
  -H "content-type: application/zip" `
  --data-binary "@$zip"
```

Successful response:

```json
{
  "ok": true,
  "modelDir": "D:\\client\\models\\alice",
  "cacheKey": "...",
  "serverModelDir": "D:\\_Project\\PA\\genie-tts-cuda-server\\models\\cache\\...\\model",
  "zipSha256": "..."
}
```

After this succeeds, retry the original generation request unchanged.

## 4. Optional SHA256 Check

The client can calculate the zip hash and send it as `X-Model-Sha256`.

```powershell
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()

curl.exe -X POST "$server/models/upload?modelDir=$encodedModelDir" `
  -H "content-type: application/zip" `
  -H "X-Model-Sha256: $hash" `
  --data-binary "@$zip"
```

If the hash does not match, the server rejects the upload.

## 5. Required Client Logic

Client pseudocode:

```text
send original TTS request with modelDir
if response is 409 and code is MODEL_NOT_UPLOADED:
  zip the preset directory that contains response.modelDir and its reference files
  POST zip to server + response.uploadUrl
  if upload succeeds:
    retry original TTS request without changing modelDir
```

Important details:

- The upload request must include the same `modelDir` string used by generation.
- The generation request does not need a `modelId`.
- The zip must contain at least one `.onnx` file.
- The zip should contain the matching `reference.wav` and `reference.txt` for that model.
- If the upload lacks reference files, generation returns `REFERENCE_NOT_UPLOADED` instead of using another preset's reference.
- If the local model changes but the path stays the same, upload again to replace the server cache.

## 6. Python Example

```python
from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from urllib.parse import quote

import requests


SERVER = "http://SERVER_LAN_IP:8767"
MODEL_DIR = r"D:\client\models\alice"


def zip_preset_for_model(model_dir: str) -> bytes:
    model_path = Path(model_dir)
    root = model_path.parent
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in root.rglob("*"):
            if path.is_file():
                archive.write(path, path.relative_to(root).as_posix())
    return buffer.getvalue()


def upload_model(model_dir: str) -> None:
    payload = zip_preset_for_model(model_dir)
    upload_url = f"{SERVER}/models/upload?modelDir={quote(model_dir, safe='')}"
    response = requests.post(
        upload_url,
        data=payload,
        headers={"content-type": "application/zip"},
        timeout=300,
    )
    response.raise_for_status()


def stream_tts(model_dir: str, texts: list[str]) -> bytes:
    url = f"{SERVER}/stream-input?language=zh&modelDir={quote(model_dir, safe='')}"
    payload = b"".join(
        json.dumps({"text": text}, ensure_ascii=False).encode("utf-8") + b"\n"
        for text in texts
    )
    response = requests.post(
        url,
        data=payload,
        headers={"content-type": "application/x-ndjson"},
        timeout=300,
    )
    if response.status_code == 409:
        body = response.json()
        if body.get("code") == "MODEL_NOT_UPLOADED":
            upload_model(body["modelDir"])
            response = requests.post(
                url,
                data=payload,
                headers={"content-type": "application/x-ndjson"},
                timeout=300,
            )
    response.raise_for_status()
    return response.content


audio = stream_tts(MODEL_DIR, ["第一段。", "第二段。"])
Path("out.pcm").write_bytes(audio)
```

## 7. Receiving Text With Each Audio Chunk

The default streaming response is raw PCM, so it cannot include text metadata. To receive text with every returned audio chunk, request NDJSON:

```powershell
$url = "$server/stream-input?language=jp&modelDir=$encodedModelDir&responseFormat=ndjson"
```

Each response line is a JSON object:

```json
{
  "type": "audio",
  "text": "これは疑似ストリーミング音声のテストです。",
  "format": "s16le",
  "sampleRate": 32000,
  "channels": 1,
  "audioBase64": "..."
}
```

The final line is:

```json
{"type":"done"}
```

`audioBase64` is the same PCM data that the default `audio/L16` response would return, base64 encoded so it can share the stream with text metadata.
