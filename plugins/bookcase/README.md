# Bookcase Plugin

`bookcase` 提供讲故事用的书橱工具。

## Tool

- `bookcase({ action: "draw", ...filters })`：抽取一本书，返回 `<book>` 母版、讲述要求和固定时间块。
- `bookcase({ action: "return" })`：归还书本，解除固定前缀并重开会话。

## Fixed Prefix Mode

`draw` 会触发 AgentCore 进入 `fixed_prefix` LLM session mode。进入时会固定当前会话前缀，后续重建为：

```text
[modeStaticMessages][check_chat({ scope: "from_prefix" })]
```

其中固定内容包括 draw 前已有会话、draw tool call 和 result；draw 前已经执行过的 fake `check_chat` 也会保持不变。`return` 会清空固定前缀并重开会话。

进入固定前缀时会记录 `modeStartedAt`、`modeExpiresAt`、`fixedPrefixKind` 和 `fixedPrefixCursorMessageId`，重启后继续保留。默认 2 小时后过期并回到 `normal` mode。

`fixed_prefix` mode 是全局 active LLM session 级别；当前不按聊天 sessionId 分开。
