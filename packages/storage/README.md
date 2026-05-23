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

- Persist message logs.
- Persist lightweight memories.
- Create SQLite FTS5 index for memory recall.
- Capture text turns after AgentCore responses.
- Recall relevant memories before AgentCore calls the LLM.

Important methods:

- `insertMessageLog(input)`
- `listMessageLogs(limit)`
- `captureTurn(event, outputs)`
- `recallForEvent(event, limit)`
- `listMemories(limit)`

SQLite state lives at:

```text
data/alice.sqlite
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
