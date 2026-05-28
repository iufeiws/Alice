# Storage

`packages/storage` contains local persistence helpers.

## SQLite Store

File:

```text
packages/storage/src/sqlite-store.ts
```

Factory:

```ts
createAliceStore(dbPath): AliceStore
```

Responsibilities:

- Persist Core-facing conversation messages.
- Persist append-only message event logs for debugging.

Important methods:

- `insertMessageLog(input)`
- `listMessageLogs(limit)`
- `upsertInboundMessage(input)`
- `insertOutboundMessage(input)`
- `listMessages(limit)`
- `listMessagesForConversation(conversationId, limit)`
- `markMessageRead(plugin, externalMessageId, readAt)`
- `markMessageRecalled(plugin, externalMessageId, recalledAt)`
- `updateMessageReaction(input)`

## Message Tables

`messages` is the Core-facing conversation state. It stores one row per inbound or outbound message with content, sender, time, send status, read/recall flags, and aggregated reactions. Core context is built from this table.

`message_logs` is an append-only event/debug log. It records Feishu callbacks, outbound send attempts, raw JSON, errors, and processing metadata. Reaction/read/recall events are stored here for debugging, then applied to the matching row in `messages`.

Schema migration backfills older message event log rows into `messages` when possible. Normal message rows become conversation messages; older read/recall/reaction events are applied as state updates to their matching message id.

SQLite state lives at:

```text
data/alice.sqlite
memory-files/message/messages.sqlite
logs/message/message-logs.sqlite
```

## File Log Store

File:

```text
packages/storage/src/file-log-store.ts
```

Factory:

```ts
createFileLogStore(root): FileLogStore
```

Responsibilities:

- Write debug/system logs as JSONL files.
- Read recent debug/system logs.
- Delete log files older than a retention window.

Current system log path:

```text
logs/system/YYYY-MM-DD.log.jsonl
```

Current retention is seven days, enforced by the scheduler at 04:00.
