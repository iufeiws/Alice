# Agent 工作说明

## 项目上下文

Alice 是一个本地优先的个人 Agent 运行时。当前范围包括 AgentCore、占位式 Agent 行为、OpenAI 兼容 `/v1` 客户端、飞书与微信渠道插件、本地管理后台、SQLite 消息历史、JSONL LLM 会话归档，以及文件化系统日志。

## 工程规则

- 优先做小而聚焦的变更。
- 不在没有充分理由时引入新依赖。
- 对于边界清晰且已有成熟方案的问题，优先使用维护良好的依赖，不重复造轮子。
- 所有 API 行为变更都需要测试。
- 后端变更需要检查授权和数据校验。
- 数据库迁移需要检查向后兼容和回滚安全。
- 引入新抽象前，先使用项目已有模式。

## 运行命令

- `npm run build`：编译 TypeScript 到 `dist/`。
- `npm run typecheck`：运行 TypeScript 类型检查，不输出文件。
- `npm run dev:api`：构建并启动单进程 API/管理后台。
- `npm test`：运行 Node 测试文件。

## GitHub

- GitHub 操作默认使用 SSH remote，例如 `git@github.com:iufeiws/Alice.git`。
- Commit message 必须描述实际变更并提供有用上下文，避免 `update`、`changes`、`update current workspace` 这类含糊信息。

## 运行时状态

- `.env` 保存本地凭据和运行时配置，不要提交密钥。
- 管理后台改动的设置必须持久化到 `.env` 或其他已记录的持久存储；可行时，当前进程应立即应用这些设置。
- `memory-files/message/messages.sqlite` 保存 Core 侧消息历史。
- `logs/message/message-logs.sqlite` 保存追加式消息事件/调试日志。
- `memory-files/llm-sessions/` 保存 LLM 会话 transcript delta 事件。
- `logs/system/` 保存调试日志，保留期由每日调度器管理。
- 日志类数据，包括 `logs/message/`、`logs/system/` 和 LLM 会话归档，不进入 LLM 上下文。用户要求删除或修改消息历史时，不要删除或编辑这些日志；除非用户明确点名日志存储，否则这类请求只适用于 Core 侧 `messages` 数据。
- `memory-files/indexes/feishu-paired-contacts.json` 保存唯一飞书联系人绑定。
- 运行时代码需要“当前时间”时，应使用 `core/time/src/index.ts` 的全局时间提供器；时区来自 `config.core.timezone`（`AGENT_TIMEZONE`，默认 `Asia/Singapore`）。保存给 Agent 使用的时间戳时，必须使用配置时区下的本地 wall-clock ISO 字符串，例如 `2026-05-25T08:00:00.000`。不要保存 UTC `Z` 时间戳或带 `+08:00` 的 offset 形式；避免直接用 `new Date().toISOString()` 写记录。

## Agent 状态说明

- 当前预期行为：在 `away`、`sleeping` 或 `working` 状态收到的消息，仍会把经过的 wall-clock 时间计入已保存的 `responseDelayMs`；当状态稍后允许回复时，如果旧待处理消息的等待时间已经超过延迟，就可能立刻处理。
- 当前预期行为：AgentCore 被视为单一非并发 worker。`working` 状态尚未为并发或嵌套 `handleEvent()` 调用设计。

## Review Checklist

- Admin API 必须校验输入，并返回 JSON 错误，而不是直接抛异常。
- 任何能发送消息、更新凭据、读取本地文件或暴露日志的端点，都必须有明确授权方案。
- 飞书运行时 start/stop 必须幂等，不能创建重复 WebSocket client。
- LLM 配置变更必须影响活跃 Agent 运行时，而不仅是未来重启。
- SQLite schema 变更在生产使用前需要迁移/版本路径。
