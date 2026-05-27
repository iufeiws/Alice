# Media Plugin

Media tools for AgentCore. The current implementation exposes one LLM tool:

- `selfie`: generate and send an Alice selfie/photo to the current Feishu session.

## Selfie Tool

`selfie` accepts one required input:

```json
{
  "action": "lean close to the camera and smile shyly"
}
```

`aspectRatio` is optional and defaults to `3:4`.

When invoked, the tool:

1. Sends `(少女拍照中...)` to the current session.
2. Builds the image prompt from:
   - Alice character features from the main prompt profile.
   - Current daily shell personality and outfit.
   - `assets/selfie/references/selfie-prompt.txt`.
3. Calls the OpenAI Image API `/v1/images/edits` with three reference images in this order:
   - `assets/selfie/references/alice-character-reference.png`
   - the current outfit image from `memory-files/shell/outfits/*.jpg`
   - `assets/selfie/references/magic-library-reference.png`
4. Writes the generated image under `assets/generated/selfies/selfie_{datetime}.jpg`.
5. Sends the generated image through the existing Feishu image output path.

The generated image directory is intentionally git-ignored. Reference images and the prompt template are source assets and should be committed.

## Image API Config

The tool defaults to fast, small, low-quality output:

```text
SELFIE_IMAGE_API_MODEL=gpt-image-2
SELFIE_IMAGE_API_SIZE=768x1024
SELFIE_IMAGE_API_QUALITY=low
SELFIE_IMAGE_API_OUTPUT_FORMAT=jpeg
SELFIE_IMAGE_API_OUTPUT_COMPRESSION=45
SELFIE_IMAGE_API_TIMEOUT_MS=120000
```

Authentication uses `SELFIE_IMAGE_API_KEY` first, then falls back to `OPENAI_API_KEY`.

Optional base URL override:

```text
SELFIE_IMAGE_API_BASE_URL=https://api.openai.com/v1
```

The implementation uses the process proxy variables when present:

```text
HTTPS_PROXY
https_proxy
HTTP_PROXY
http_proxy
```

## Guardrails

AgentCore rejects two consecutive `selfie` tool calls. If the previous completed tool call was also `selfie`, the next `selfie` returns:

```text
selfie cannot be called twice in a row
```

Any other tool call between two selfies resets this guard.

## Manual Speed Test

Run the standalone API test without connecting it to the agent tool:

```bash
npm run test:selfie-api -- "靠近镜头，轻轻歪头，露出有点害羞的表情"
```

The test writes output to:

```text
assets/generated/selfies/api-tests/
```
