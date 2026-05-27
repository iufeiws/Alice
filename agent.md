# Agent Working Notes

## Project Context

Alice is a local-first personal agent runtime. The current scope is an agent core with placeholder agent behavior, an OpenAI-compatible `/v1` client surface for providers such as opencode and DeepSeek-compatible APIs, a Feishu channel plugin, a local admin console, SQLite-backed message and memory history, and file-backed system logs.

## Engineering Rules

- Prefer small, focused changes.
- Do not introduce new dependencies without justification.
- All API behavior changes require tests.
- For backend changes, check authorization and data validation.
- For database migrations, check backward compatibility and rollback safety.
- Use existing project patterns before introducing new abstractions.

## Runtime Commands

- `npm run build`: compile TypeScript into `dist/`.
- `npm run typecheck`: run TypeScript without emit.
- `npm run dev:api`: build and start the single API/admin process.
- `npm test`: run Node test files.

## Runtime State

- `.env` stores local credentials and runtime settings. Do not commit secrets.
- Every setting changed from the admin console must be persisted to `.env` or another documented durable store, and the active process should apply it immediately when practical.
- `data/alice.sqlite` stores message logs and memory records.
- `logs/system/` stores debug logs; retention is managed by the daily scheduler.
- `memory-files/indexes/feishu-paired-contacts.json` stores the single bound Feishu contact state.
- Runtime code that needs "now" should use the global current-time provider in `core/time/src/index.ts`, configured from `config.core.timezone` (`AGENT_TIMEZONE`, default `Asia/Singapore`). Persisted agent-facing timestamps must be saved as local wall-clock ISO strings in the configured timezone, for example `2026-05-25T08:00:00.000`. Do not save UTC `Z` timestamps or offset-suffixed forms such as `+08:00`; avoid direct `new Date().toISOString()` for records.

## Agent State Notes

- Current expected behavior: messages received during `away`, `sleeping`, or `working` still count elapsed wall-clock time toward the saved `responseDelayMs`; when the state later allows replies, old pending messages may be handled immediately if their elapsed time already exceeds the delay.
- Current expected behavior: AgentCore is treated as a single non-concurrent worker. `working` is not designed for concurrent or nested `handleEvent()` calls yet.

## Review Checklist

- Admin APIs must validate inputs and return JSON errors instead of throwing.
- Any endpoint that can send messages, update credentials, read local files, or expose logs must have an explicit authorization story.
- Feishu runtime start/stop should be idempotent and should not create duplicate websocket clients.
- LLM configuration changes must affect the active agent runtime, not only future restarts.
- SQLite schema changes need a migration/versioning path before production use.
