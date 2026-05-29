# Log retention notes

- Treat every path under `logs/` as system/operational log data, including `logs/message/message-logs.sqlite`.
- When asked to clear chat/message history, only modify the Core message store under `memory-files/message/messages.sqlite` unless the user explicitly names a `logs/` path.
