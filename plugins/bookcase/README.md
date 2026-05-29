# Bookcase Plugin

`bookcase` 提供讲故事用的书橱工具。

## Tool

- `bookcase({ action: "draw", ...filters })`：抽取一本书，返回 `<book>` 母版、讲述要求和固定时间块。
- `bookcase({ action: "return" })`：归还书本，退出书橱讲故事模式。

## Storyteller Mode

`draw` 会触发 AgentCore 进入 `storyteller` LLM session mode。进入时会丢弃 draw 前的长会话上下文，重建为：

```text
[静态 prompt][bookcase draw tool call + result][check_chat]
```

其中 bookcase draw 的 tool call/result 会作为 `modeStaticMessages` 持久化，不会在每次重建时重新抽书。`return` 会切回 `normal` mode 并清空这些静态书橱消息。

进入 storyteller 时会记录 `modeStartedAt`，重启后继续保留。若下一次 LLM 请求发现 storyteller 已持续 2 小时，AgentCore 会自动回到 `normal` mode。

`storyteller` mode 是全局 active LLM session 级别；当前不按聊天 sessionId 分开。
