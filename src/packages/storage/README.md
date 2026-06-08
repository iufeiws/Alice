# Storage 说明

`packages/storage` 包含本地持久化辅助能力。

## SQLite Store 说明

文件：

```text
packages/storage/src/sqlite-store.ts
```

工厂函数：

```ts
createAliceStore(dbPath): AliceStore
```

职责：

- 持久化 Core 侧会话消息。
- 持久化追加式消息事件日志，方便调试。

重要方法：

- `insertMessageLog(input)`
- `listMessageLogs(limit)`
- `upsertInboundMessage(input)`
- `insertOutboundMessage(input)`
- `listMessages(limit)`
- `listMessagesForConversation(conversationId, limit)`
- `searchMessages(input)`
- `listPendingCoreConversations()`
- `listUnprocessedCoreMessagesForConversation(conversationId, limit)`
- `markMessagesCoreProcessed(ids, processedAt, batchId)`
- `markMessagesReadAndCoreProcessed(ids, readAt, batchId)`
- `listPendingOutboundMessages(plugin, limit)`
- `markOutboundMessageSent(id, externalMessageId, sentAt)`
- `markOutboundMessageFailed(id, failedAt, failureReason)`
- `markMessageRead(plugin, externalMessageId, readAt)`
- `markMessageRecalled(plugin, externalMessageId, recalledAt)`
- `updateMessageReaction(input)`

## 消息表

`messages` 是 Core 侧会话状态表。它为每条入站或出站消息保存一行，包含内容、发送者、时间、发送状态、已读/撤回标记与聚合 reaction。Core 会基于这个表构造上下文。
`messages_fts` 是 `messages.content_text` 的 FTS5 索引，由 `searchMessages()` 使用。

`message_logs` 是追加式事件/调试日志。它记录飞书回调、出站发送尝试、原始 JSON、错误和处理元数据。Reaction/read/recall 事件会先存到这里用于调试，然后应用到 `messages` 中匹配的消息行。

Schema migration 会在可行时把旧消息事件日志回填到 `messages`。普通消息行会变为会话消息；旧的 read/recall/reaction 事件会作为状态更新应用到匹配的 message id。

当前 API 进程会把 Core 侧消息和追加式事件日志拆到两个 SQLite 文件；`data/alice.sqlite` 是旧的根路径兼容入口：

```text
data/alice.sqlite
memory-files/message/messages.sqlite
logs/message/message-logs.sqlite
```

`logs/message/message-logs.sqlite` 属于 `logs/` 下的系统/运行日志。清理聊天历史时只处理 `memory-files/message/messages.sqlite`，不要修改 `logs/`，除非明确是在清系统日志。

## File Log Store 说明

文件：

```text
packages/storage/src/file-log-store.ts
```

工厂函数：

```ts
createFileLogStore(root): FileLogStore
```

职责：

- 把调试/系统日志写成 JSONL 文件。
- 读取最近的调试/系统日志。
- 删除超过保留期的日志文件。

当前系统日志路径：

```text
logs/system/YYYY-MM-DD.log.jsonl
```

当前保留期为 7 天，由调度器在 04:00 执行。
