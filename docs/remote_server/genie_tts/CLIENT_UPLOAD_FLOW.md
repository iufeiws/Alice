# Genie TTS 客户端上传流程

本文档描述局域网 Genie TTS 服务在客户端本地模型未上传时的客户端行为。

## 正常生成请求

客户端仍然在生成请求中传本地 `modelDir`。服务端如果已经有该模型缓存，就正常返回音频。

流式文本输入示例：

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

## 模型缺失响应

服务端没有该 `modelDir` 对应缓存时，返回 HTTP `409`：

```json
{
  "ok": false,
  "code": "MODEL_NOT_UPLOADED",
  "modelDir": "D:\\client\\models\\alice",
  "uploadUrl": "/models/upload?modelDir=D%3A%5Cclient%5Cmodels%5Calice"
}
```

客户端必须上传响应里同一个 `modelDir` 对应的模型 preset，然后重试原始生成请求。

## 上传 preset

客户端把模型和匹配的参考文件打包成 zip，并 POST 到 `uploadUrl`。

服务端接受两种 zip 结构：

```text
model/
  *.onnx
reference.wav
reference.txt
```

或：

```text
*.onnx
reference.wav
reference.txt
```

显式 `modelDir` 请求必须使用同一 preset 的 `reference.wav` 和 `reference.txt`，除非生成请求显式传入 `referenceAudioPath` 和 `referenceText`。

上传示例：

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

上传成功后，客户端重试原始 `/stream-input` 或 `/synthesize` 请求。

## 可选校验

客户端可以先计算 zip SHA256，并在上传时附带校验信息。服务端实现如果返回校验错误，客户端应重新打包同一 preset，而不是换用其它模型。

## 客户端要求

- 不要把一个 preset 的模型和另一个 preset 的参考音频混用。
- 不要依赖服务端默认 reference 来满足显式 `modelDir` 请求。
- `MODEL_NOT_UPLOADED` 后只上传响应中指定的模型。
- 上传后重试原请求，不改变文本、语言和模型参数。

## 非流式合成

非流式合成同样使用 `modelDir`。远端服务合成时不需要客户端传 `outputPath`；客户端只接收服务端返回的音频或元数据。

