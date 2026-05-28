# Media Plugin 说明

Media tools 供 AgentCore 使用。当前实现暴露一个 LLM 工具：

- `selfie`：生成并发送一张 Alice 自拍/照片到当前聊天会话。

## Selfie 工具说明

`selfie` 接收一个必填输入：

```json
{
  "action": "lean close to the camera and smile shyly"
}
```

`aspectRatio` 可选，默认 `3:4`。

调用后，工具会：

1. 向当前会话发送 `-少女拍照中-`。
2. 从以下来源构造图片 prompt：
   - 主 prompt profile 中的 Alice 角色特征。
   - 当前日常 shell personality 与 outfit。
   - `assets/selfie/references/selfie-prompt.txt`。
3. 默认通过 `Skill/external/alice-selfie-fast/scripts/run-alice-selfie-fast.mjs --tool-input ...` 调用 Image API `/v1/images/edits`。内置 direct executor 和 Codex executor 仍保留为代码路径，但默认 executor 是 fast runner。
4. 按以下顺序传入参考图：
   - `assets/selfie/references/alice-character-reference.png`
   - `memory-files/shell/outfits/*.jpg` 中当前 outfit 对应图片
   - `assets/selfie/references/magic-library-reference.png`
5. 如果当前 outfit 图片缺失，不直接失败；只传角色和图书馆参考图，并把服装信息作为文字写入 prompt。
6. 把生成图片写入 `assets/generated/selfies/selfie_{datetime}.jpg`。
7. 通过当前渠道的 image output 路径发送生成图片。

生成图片目录故意被 git 忽略。参考图和 prompt 模板是源码资产，应提交。

## Image API 配置说明

工具默认使用快速、小尺寸、低质量输出：

```text
SELFIE_IMAGE_API_MODEL=gpt-image-2
SELFIE_IMAGE_API_SIZE=768x1024
SELFIE_IMAGE_API_QUALITY=low
SELFIE_IMAGE_API_OUTPUT_FORMAT=jpeg
SELFIE_IMAGE_API_OUTPUT_COMPRESSION=45
SELFIE_IMAGE_API_TIMEOUT_MS=120000
```

认证优先使用 `SELFIE_IMAGE_API_KEY`，缺失时回退到 `OPENAI_API_KEY`。

可选 base URL 覆盖：

```text
SELFIE_IMAGE_API_BASE_URL=https://api.openai.com/v1
```

如果 `SELFIE_IMAGE_API_BASE_URL` 未配置，会先使用 `OPENAI_BASE_URL`，再回退到 OpenAI 默认 `/v1` base URL。

实现会使用进程里存在的代理环境变量：

```text
HTTPS_PROXY
https_proxy
HTTP_PROXY
http_proxy
```

## 保护规则

AgentCore 会拒绝连续两次 `selfie` tool call。如果上一个完成的工具调用也是 `selfie`，下一次 `selfie` 会返回：

```text
selfie cannot be called twice in a row
```

两次自拍之间有任意其他 tool call 时，这个保护会重置。

工具还会要求输出目录位于项目 `assets/` 内，并检查生成文件扩展名和 `SELFIE_MAX_BYTES`。

## 手动测速

运行独立 API 测试，不把它接入 Agent 工具：

```bash
npm run test:selfie-api -- "靠近镜头，轻轻歪头，露出有点害羞的表情"
```

测试输出写入：

```text
assets/generated/selfies/api-tests/
```
