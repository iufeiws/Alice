# API 应用

`apps/api` 是当前进程入口，负责托管 HTTP API、管理后台、AgentCore 启动、飞书/微信插件接线、工具插件接线、存储初始化与调度器注册。

## 入口文件

```text
apps/api/src/index.ts
```

当前原型阶段这个文件有意保持单体结构。它会加载 `.env`、构建配置、创建 SQLite 与文件日志存储、接入 AgentCore 依赖、注册飞书/微信 Channel Plugin 与 messaging/media/shell Tool Plugin，并启动 HTTP 服务。

## 主要运行时职责

- 服务 `/admin`。
- 服务管理后台 JSON API。
- 创建 `AgentCore`。
- 创建飞书与微信 Channel Plugin。
- 创建 messaging、media 与 shell Tool Plugin。
- 通过 `packages/storage` 持久化 Core 侧消息和消息事件日志。
- 通过文件日志存储持久化系统日志。
- 归档活跃 LLM 会话 transcript delta。
- 注册每日 04:00 清理任务。

## HTTP 端点

通用：

- `GET /healthz`
- `GET /admin`
- `GET /v1/models`

管理后台配置：

- `GET /admin/api/config`
- `PUT /admin/api/config/llm`
- `PUT /admin/api/config/feishu`
- `PUT /admin/api/config/wechat`
- `PUT /admin/api/config/agent`
- `GET /admin/api/agent-state`
- `PUT /admin/api/agent-state`

Prompt 与 shell：

- `GET /admin/api/prompts`
- `GET /admin/api/prompt-profile`
- `PUT /admin/api/prompt-profile`
- `GET /admin/api/shell`
- `GET /admin/api/shell-ui/order`
- `PUT /admin/api/shell-ui/order`
- `PUT /admin/api/shell-prompt`
- `PUT /admin/api/shell-settings`
- `PUT /admin/api/shell-option`
- `DELETE /admin/api/shell-option`
- `POST /admin/api/shell/outfit-image`
- `POST /admin/api/shell/reroll`

管理后台日志：

- `GET /admin/api/llm-requests`
- `GET /admin/api/llm-responses`
- `POST /admin/api/llm-chain/clear`
- `GET /admin/api/logs`
- `GET /admin/api/message-logs`
- `GET /admin/api/message-event-logs`
- `GET /admin/api/runtime/status`
- `POST /admin/api/runtime/heartbeat/pause`
- `POST /admin/api/runtime/heartbeat/resume`
- `POST /admin/api/runtime/process-now`

飞书：

- `GET /admin/api/plugins/feishu/status`
- `POST /admin/api/plugins/feishu/start`
- `POST /admin/api/plugins/feishu/stop`
- `GET /admin/api/plugins/feishu/pairings`
- `POST /admin/api/plugins/feishu/test-markdown`
- `POST /admin/api/plugins/feishu/test-image`
- `POST /admin/api/plugins/feishu/test-audio`

微信 iLink：

- `GET /admin/api/plugins/wechat/status`
- `POST /admin/api/plugins/wechat/start`
- `POST /admin/api/plugins/wechat/stop`
- `GET /admin/api/plugins/wechat/contacts`
- `POST /admin/api/plugins/wechat/login/qrcode`
- `GET /admin/api/plugins/wechat/login/status?qrcode=...`

Messaging tool 试用：

- `POST /admin/api/tools/messaging/view`
- `POST /admin/api/tools/messaging/search`
- `POST /admin/api/tools/messaging/send`
- `POST /admin/api/tools/messaging/wechat-view`
- `POST /admin/api/tools/messaging/wechat-search`
- `POST /admin/api/tools/messaging/wechat-send`

静态资产：

- `GET /admin/assets/shell/...`

## 关键辅助函数

- `appendLog(level, message)`：把系统/调试日志写入进程内历史和本地 JSONL 文件。
- `appendMessageLog(input)`：把追加式消息事件/调试条目写入进程内历史和 SQLite。
- `appendLLMRequestLog(input)`：记录最近的 LLM chat payload，供管理后台查看。
- `createLLMClientFromConfig()`：选择 OpenAI 兼容客户端或 stub LLM 客户端。
- `resolveFeishuTestTarget(body)`：把管理后台发送测试解析到唯一绑定的飞书联系人。
- `updateEnvFile(path, updates)`：更新 `.env`，并保留未提交的密钥字段。
- `renderAdminHtmlV2()`：返回当前管理后台 HTML。
- `clearLLMChainCache()`：清理当前活跃 LLM 会话。

## 运行说明

系统日志是调试产物，位于 `logs/system`。Core 侧消息位于 `memory-files/message/messages.sqlite`，消息事件日志位于 `logs/message/message-logs.sqlite`。运行时代码来自 `dist`，因此代码变更后需要重启 API 进程。

## 消息运行时

运行时使用两层存储：

- `messages`：每条会话消息一行，表示当前状态。Core 用它构造上下文，管理后台 Message Log 也把它作为聊天历史展示。
- `message_logs`：追加式事件/调试条目，记录飞书回调、发送尝试、原始 JSON 与失败信息。

飞书文本消息会 upsert `messages` 并把会话标记为 dirty。飞书 reaction/read/recall 回调只更新匹配的 `messages` 行并写入调试条目，不会单独触发 Core。

管理后台的 `LLM Request` 与 `LLM Chain` 标签会展示 prompt 预览、最近请求/响应、活跃会话和已清理会话。AgentCore 在调用配置的 provider 或 stub client 前，会记录最终的 `messages` 数组。
