# Alice

Personal companion agent framework based on the AgentCore / Plugin architecture in
`agent_core_plugin_architecture.md`.

For the current implemented architecture, see `ARCHITECTURE.md`.

## Current Implementation

- TypeScript monorepo skeleton with pnpm workspace metadata.
- AgentCore runtime boundary:
  - standardized `AgentEvent` and `AgentOutput`
  - in-memory event/session/output routing
  - editable prompt profile with memory recall/capture hooks
- Internal OpenAI-compatible `/v1` LLM client:
  - supports configurable `LLM_BASE_URL`
  - works with OpenAI, DeepSeek, opencode, and similar `/v1/chat/completions` providers
  - supports OpenAI-style function tool calls executed by AgentCore
  - falls back to a stub client when no API key/base URL is configured
- Feishu channel plugin:
  - WebSocket event subscription via Feishu/Lark SDK
  - text message normalization into `AgentEvent`
  - unique user pairing with `/pair alice`
  - text, markdown, image, audio, and file sending
- Media tool plugin:
  - `selfie` tool for Image API-generated Alice photos
  - uses character, outfit, and library reference images
  - sends a short in-progress message before image generation
  - rejects consecutive `selfie` tool calls
- Local persistence:
  - SQLite message logs and memory
  - SQLite FTS5 search over persisted messages
  - file-based system logs with seven-day retention
- Admin UI at `http://127.0.0.1:3030/admin`.

## Commands

```bash
npm install
npm run typecheck
npm run dev:api
```

The preferred package manager metadata is pnpm, but npm can run the current scripts.

`npm run dev:api` builds TypeScript and starts the compiled API process.

## Environment

Copy `.env.example` and set provider-specific values:

```bash
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=...
LLM_MODEL=deepseek-chat
```

For a local opencode-compatible endpoint, point `LLM_BASE_URL` at its `/v1` base URL.

For the selfie image tool, set an OpenAI Image API key:

```bash
OPENAI_API_KEY=...
```

See `plugins/media/README.md` for detailed media tool configuration and the standalone speed test command.

## Important Local State

```text
.env
data/alice.sqlite
logs/system/*.log.jsonl
memory-files/indexes/feishu-paired-contacts.json
memory-files/config/prompt-profile.json
```

`data/`, `logs/`, `.env`, `dist/`, and `node_modules/` are ignored by git.
