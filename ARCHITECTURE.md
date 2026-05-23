# Alice Architecture

Alice is a local-first personal companion agent runtime. The current implementation is a single Node.js/TypeScript process that combines the API host, admin UI, AgentCore runtime, Feishu channel plugin, LLM adapter, message persistence, memory recall, and scheduler.

The older `agent_core_plugin_architecture.md` describes the broader target architecture. This document describes what the current code actually implements.

## Runtime Shape

```text
apps/api
  HTTP API + Admin UI + process bootstrap
    |
    | creates
    v
AgentCore
  Intent routing
  LLM call
  memory recall/capture hooks
    |
    | sends AgentOutput through
    v
OutputRouter
    |
    v
Feishu Channel Plugin
  WebSocket event subscription
  text normalization
  unique user pairing
  markdown/image/audio/file sending
```

The process also starts a daily scheduler. The first scheduled task runs at 04:00 local process time and deletes system log files older than seven days.

## Data Flow

### Feishu Message Turn

```text
Feishu WS event
  -> plugins/feishu client
  -> textMessageEventToAgentEvent()
  -> pairing and Feishu policy checks
  -> AgentCore.handleEvent()
  -> memory recall from SQLite
  -> OpenAI-compatible /v1/chat/completions call
  -> memory capture into SQLite
  -> AgentOutput
  -> OutputRouter
  -> Feishu send API
```

Inbound and outbound user-facing messages are persisted as message logs in SQLite. System/debug logs are written to local JSONL files.

### Admin Send Test

```text
Admin UI
  -> /admin/api/plugins/feishu/test-*
  -> first unique bound Feishu contact
  -> Feishu markdown/image/audio send path
  -> message log + system log
```

## State Locations

```text
.env
  Runtime config and secrets. Not committed.

data/alice.sqlite
  Message logs and memory records. Not committed.

logs/system/YYYY-MM-DD.log.jsonl
  Debug/system logs. Not committed. Retained for seven days.

memory-files/indexes/feishu-paired-contacts.json
  Unique Feishu binding for the one allowed user/contact.

assets/
  Local test assets, currently including generated image/audio test files.
```

## Public Protocols

The shared internal protocol lives in `packages/types`.

- `AgentEvent`: normalized inbound event from any channel.
- `AgentPayload`: normalized message payload.
- `AgentOutput`: normalized outbound message.
- `ChannelPlugin`: channel lifecycle and send interface.
- `ToolPlugin`: placeholder interface for future tool plugins.

AgentCore only consumes `AgentEvent` and emits `AgentOutput`; platform-specific details stay in plugins.

## Persistence And Memory

Alice follows the same broad split used by local-first agent systems such as OpenClaw and Harness-style agents:

- Message/session history is stored as structured local state.
- System logs are local debug artifacts with retention.
- Memory is indexed separately and recalled before an agent turn.

Current implementation:

- SQLite table `message_logs` persists user-visible message history.
- SQLite table `memories` stores lightweight episodic memories.
- SQLite FTS5 table `memories_fts` supports keyword recall.
- `AgentCoreDeps.memory.recall()` injects relevant memory as an additional system message.
- `AgentCoreDeps.memory.capture()` stores user and assistant text after each turn.

This is intentionally simple. There is no quality gate, summarizer, embedding model, vector search, or memory editing UI yet.

## Scheduler

`core/scheduler` provides a process-local daily scheduler:

- `createDailyScheduler(tasks)`
- `delayUntilNext(hour, minute, from)`

The API process registers one task:

```text
04:00 daily -> cleanup system log files older than 7 days
```

This scheduler is not distributed. If the process is down at 04:00, the task will not run until the next scheduled time after restart.

## Admin UI

`/admin` is a single HTML page served by `apps/api`.

Layout:

- Left collapsible panel:
  - LLM Settings
  - Feishu Settings, including send tests and unique binding info
- Right panel:
  - Prompt
  - Message Log
  - System Log

The UI uses the JSON endpoints in `apps/api/src/index.ts`; there is no separate frontend build.

## Current Limitations

- Only one Feishu user/contact can be bound.
- Agent behavior is still a placeholder prompt.
- Memory extraction is heuristic and text-only.
- Message logs persist, but older in-memory-only logs from before SQLite migration cannot be recovered.
- Feishu receive path currently normalizes text messages only.
- Feishu send path supports markdown card, image, audio, and file, but media must be provided as local file paths.
- Codex, skills, workers, desktop pet, and full web admin are still placeholders.
