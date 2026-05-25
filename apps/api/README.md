# API App

`apps/api` is the current process entrypoint. It hosts the HTTP API, admin UI, AgentCore bootstrap, Feishu plugin wiring, storage setup, and scheduler registration.

## Entry Point

```text
apps/api/src/index.ts
```

The file is intentionally monolithic for the current prototype. It loads `.env`, builds config, creates the SQLite and file log stores, wires AgentCore dependencies, registers Feishu, and starts the HTTP server.

## Main Runtime Responsibilities

- Serve `/admin`.
- Serve JSON admin APIs.
- Create `AgentCore`.
- Create the Feishu channel plugin.
- Persist Core-facing messages, message event logs, and memories through `packages/storage`.
- Persist system logs through file log storage.
- Register the daily 04:00 cleanup task.

## HTTP Endpoints

General:

- `GET /healthz`
- `GET /admin`
- `GET /v1/models`

Admin config:

- `GET /admin/api/config`
- `PUT /admin/api/config/llm`
- `PUT /admin/api/config/feishu`

Admin logs and memory:

- `GET /admin/api/llm-requests`
- `GET /admin/api/logs`
- `GET /admin/api/message-logs`
- `GET /admin/api/message-event-logs`
- `GET /admin/api/memories`

Feishu:

- `GET /admin/api/plugins/feishu/status`
- `POST /admin/api/plugins/feishu/start`
- `POST /admin/api/plugins/feishu/stop`
- `GET /admin/api/plugins/feishu/pairings`
- `POST /admin/api/plugins/feishu/test-markdown`
- `POST /admin/api/plugins/feishu/test-image`
- `POST /admin/api/plugins/feishu/test-audio`

## Helper Functions

- `appendLog(level, message)`: writes system/debug logs to memory and local JSONL files.
- `appendMessageLog(input)`: writes append-only message event/debug entries to memory and SQLite.
- `appendLLMRequestLog(input)`: records recent LLM chat payloads for the admin panel.
- `createLLMClientFromConfig()`: chooses OpenAI-compatible or stub LLM client.
- `resolveFeishuTestTarget(body)`: resolves admin send tests to the unique bound Feishu contact.
- `updateEnvFile(path, updates)`: updates `.env` while preserving omitted secret fields.
- `renderAdminHtmlV2()`: returns the current admin page HTML.

## Operational Notes

System logs are debug artifacts and live under `logs/system`. Core-facing messages, message event logs, and memory live in `data/alice.sqlite`. The API process must be restarted after code changes because the runtime uses compiled files from `dist`.

## Message Runtime

The runtime uses two storage layers:

- `messages`: one current-state row per conversation message. Core reads this table to build context, and the admin Message Log view displays it as chat history.
- `message_logs`: append-only event/debug entries for Feishu callbacks, send attempts, raw JSON, and failures.

Feishu text messages upsert `messages` and mark a conversation dirty. Feishu reaction/read/recall callbacks only update the matching `messages` row and write debug entries; they do not trigger Core on their own.

The admin panel exposes the latest prebuilt LLM chat request under the `LLM Request` tab. AgentCore records the final `messages` array immediately before calling the configured provider or stub client.
