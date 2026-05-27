# Config

`packages/config` loads runtime configuration from environment variables.

## Public API

```ts
loadConfig(env = process.env): AppConfig
```

## LLM Config

Environment variables:

- `LLM_PROVIDER`
- `LLM_BASE_URL`
- `LLM_API_KEY`
- `LLM_MODEL`
- `LLM_TEMPERATURE`
- `LLM_TIMEOUT_MS`

If `LLM_BASE_URL` and `LLM_API_KEY` are both present, provider becomes `openai-compatible`; otherwise the API process uses the stub LLM client.

## Feishu Config

Environment variables:

- `FEISHU_ENABLED`
- `FEISHU_CONNECTION_MODE`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_REQUIRE_MENTION`

Default policy is conservative:

- DM policy: `pairing`
- Group policy: `allowlist`
- Require mention in groups: enabled
- Codex command policy: allowlist and explicit command required

## Media Config

Selfie image generation uses OpenAI Image API-compatible settings:

- `OPENAI_API_KEY`
- `SELFIE_IMAGE_API_KEY`
- `SELFIE_IMAGE_API_BASE_URL`
- `SELFIE_IMAGE_API_MODEL`
- `SELFIE_IMAGE_API_SIZE`
- `SELFIE_IMAGE_API_QUALITY`
- `SELFIE_IMAGE_API_OUTPUT_FORMAT`
- `SELFIE_IMAGE_API_OUTPUT_COMPRESSION`
- `SELFIE_IMAGE_API_TIMEOUT_MS`
- `SELFIE_REFERENCE_DIR`
- `SELFIE_OUTPUT_DIR`
- `SELFIE_MAX_BYTES`

`SELFIE_IMAGE_API_KEY` overrides `OPENAI_API_KEY` for the selfie tool. Generated images are written under `assets/generated/selfies/` by default.

## Node Type Declarations

`node-http.d.ts` and `globals.d.ts` provide lightweight declarations for Node APIs used by this prototype.
