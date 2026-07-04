# 后台 Terminal 日志面板

Terminal 日志面板是后台底部的运行观察区，用于查看当前进程内的消息、事件、LLM session 和系统日志。

## 当前结构

实现入口：

- `src/apps/api/admin-ui/terminal.ts`
- `src/apps/api/admin-ui/terminal-script.ts`
- `src/apps/api/admin-ui/scripts/admin-script.ts`

页面默认折叠，展开后按固定间隔刷新。

## 标签页

当前面板包含：

- Active Session
- Message
- Event
- System

Active Session 用于查看活跃 LLM session 的最新请求/响应概览。Message 和 Event 用于查看 conversation-hub 相关记录。System 用于查看系统日志摘要。

## 边界

日志类数据不进入 LLM 上下文。用户要求删除或修改消息历史时，除非明确点名日志存储，否则不应删除或修改日志。

