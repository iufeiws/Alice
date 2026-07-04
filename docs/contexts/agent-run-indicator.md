# Agent 运行指示器

Agent run indicator 位于 `src/contexts/agent-run-indicator`，用于把 Agent 运行状态投递给支持动态卡片的 channel。

## 当前职责

- 记录 run start、stream、tool call、完成和失败等事件。
- 给飞书动态卡片渲染运行中状态。
- 支持 tool block 和追加 tool call 信息。

## 边界

Run indicator 不是消息发送能力，不替代 `Chat action=send`，也不写入普通聊天消息历史。
