# Alice 架构

Alice 是一个本地优先的个人陪伴型 Agent 运行时。当前实现是单进程 Node.js/TypeScript 应用，在同一个 API 进程内组合了 HTTP 服务、管理后台、AgentCore、飞书 Channel Plugin、微信 iLink Channel Plugin、LLM 适配器、消息持久化与调度器。

较早的 [agent_core_plugin_architecture.md](/home/wyf98/Alice/agent_core_plugin_architecture.md) 描述的是更完整的目标架构；本文档描述当前代码已经实现的结构。

## 运行时形态

```text
apps/api
  HTTP API + 管理后台 + 进程启动入口
    |
    | 创建
    v
AgentCore
  意图路由
  LLM 调用
  工具调用执行
  可编辑 prompt profile 渲染
  附加 prompt 层渲染
  每日 shell prompt 注入
    |
    | 通过 AgentOutput 交给
    v
OutputRouter
    |
    v
Channel Plugin
  飞书：WebSocket 事件订阅、文本规范化、生命周期事件、唯一用户绑定、Markdown/图片/音频/文件发送
  微信 iLink：长轮询、文本规范化、扫码登录状态、基于 context_token 的文本/图片/音频发送与 typing
```

进程还会启动每日调度器。当前注册的任务在本地进程时间 04:00 运行，删除超过 7 天的系统日志文件。

## 数据流

### 飞书消息回合

```text
Feishu WebSocket event
  -> plugins/feishu client
  -> textMessageEventToAgentEvent()
  -> pairing 与飞书策略检查
  -> messages 表 upsert
  -> message event log 追加
  -> MessageRuntime 脏会话防抖
  -> AgentCore.handleEvent()，使用 messages 构造上下文
  -> OpenAI 兼容 /v1/chat/completions 调用
  -> 可选的平台无关 messaging/media/shell tool calls
  -> AgentOutput 以 messages.status=sending 写入
  -> OutputRouter
  -> 飞书发送 API
  -> messages.status=sent 或 send_failed
```

入站与出站的用户可见消息会持久化到 SQLite 的 Core 侧 `messages` 表。飞书回调和发送尝试同时写入追加式 `message_logs` 事件/调试日志。系统调试日志写入本地 JSONL 文件。

飞书生命周期回调是消息状态更新，不会作为独立 Core 消息处理：

- `im.message.reaction.created_v1` 与 `im.message.reaction.deleted_v1` 更新 `messages.reactions_json`。
- `im.message.message_read_v1` 更新 `messages.is_read/read_at`。
- `im.message.recalled_v1` 更新 `messages.is_recalled/recalled_at`。

### 微信 iLink 消息回合

```text
getupdates 长轮询
  -> plugins/wechat client
  -> 文本消息规范化
  -> messages 表 upsert
  -> message event log 追加
  -> MessageRuntime 脏会话防抖
  -> AgentCore.handleEvent()
  -> AgentOutput
  -> OutputRouter
  -> sendmessage，使用缓存的 context_token
```

微信登录状态保存在 `memory-files/indexes/wechat-ilink-state.json`。主动发送依赖入站消息产生的 `context_token`，因此只能发送给此前发过消息的微信用户。
微信发送图片和音频时，插件只接受项目 `assets/` 目录内的本地文件路径，并先走 iLink/CDN 上传。

### 管理后台发送测试

```text
Admin UI
  -> /admin/api/plugins/feishu/test-*
  -> 第一个唯一绑定的飞书联系人
  -> 飞书 markdown/image/audio 发送路径
  -> message log + system log
```

## 状态位置

```text
.env
  运行时配置与密钥，不提交。

data/alice.sqlite
  旧的根目录 SQLite 路径，不提交。

logs/system/YYYY-MM-DD.log.jsonl
  调试/系统日志，不提交，保留 7 天。

logs/message/message-logs.sqlite
  追加式消息事件/调试日志，不提交。

memory-files/message/messages.sqlite
  Core 侧会话历史与消息 FTS 索引，不提交。

memory-files/llm-sessions/*.sessions.jsonl
  活跃和已清理 LLM 会话的 delta 事件归档，不提交。

memory-files/indexes/feishu-paired-contacts.json
  唯一飞书用户/联系人绑定。

memory-files/indexes/wechat-ilink-state.json
  微信 iLink 登录态、账号 baseurl 与 token 缓存。

memory-files/config/prompt-profile.json
  可编辑 prompt 层、用户名、变量与可见工具组。

memory-files/shell/
  每日 shell、shell 配置、prompt 模板和服装图片索引。

assets/
  本地测试资产，包括生成的图片和音频测试文件。
```

## 公共协议

共享内部协议定义在 `packages/types`：

- `AgentEvent`：任意渠道规范化后的入站事件。
- `AgentPayload`：规范化消息负载。
- `AgentOutput`：规范化出站消息。
- `ChannelPlugin`：渠道生命周期与发送接口。
- `ToolPlugin`：AgentCore 可执行的平台无关 function tools。

AgentCore 只消费 `AgentEvent` 并产出 `AgentOutput`。消息发送通常通过 `messaging` tool 写入存储后交给 `OutputRouter`，平台细节留在 plugin 内部。

## 持久化

Alice 按本地优先 Agent 系统常见方式拆分状态：

- 消息和会话历史保存为结构化本地状态。
- 系统日志是带保留期的本地调试产物。
- 长期历史记忆尚未实现。

当前实现：

- SQLite 表 `message_logs` 持久化用户可见消息事件和调试条目。
- SQLite 表 `messages` 保存用户可见会话历史，并通过 `messages_fts` 支持持久消息搜索工具。
- JSONL 会话归档保存活跃和近期清理的 LLM transcript delta，用于连续性和后台检查。
- `memory-files/shell/` 保存每日 shell、可编辑 shell 配置、prompt 模板和服装图片。

目前还没有质量门禁、摘要器、embedding 模型、向量记忆或记忆编辑 UI。

## 调度器

`core/scheduler` 提供进程内每日调度器：

- `createDailyScheduler(tasks)`
- `delayUntilNext(hour, minute, from)`

API 进程注册了一个任务：

```text
每日 04:00 -> 清理超过 7 天的系统日志文件
```

该调度器不是分布式的。如果进程在 04:00 停止，任务不会补跑，只会等重启后的下一个计划时间。

## 管理后台

`/admin` 是由 `apps/api` 直接服务的单页 HTML。

布局：

- 左侧可折叠面板：
  - LLM Settings
  - Channel Settings，包括飞书/微信配置、发送测试、messaging tool 试用和绑定信息。
- 右侧面板：
  - Prompt
  - Message Log
  - System Log

UI 使用 `apps/api/src/index.ts` 中的 JSON 端点，没有独立前端构建。

## 当前限制

- 飞书只允许绑定一个用户/联系人。
- Agent 行为仍以 prompt 和工具协议为主，还不是完整人格系统。
- 管理后台可编辑 prompt profile，但当前只有一个本地活跃 profile。
- 记忆提取仍是文本启发式。
- Core 侧消息已持久化，但迁移到 SQLite 之前仅存在内存里的旧日志无法恢复。
- 飞书接收路径目前规范化文本消息，以及 reaction/read/recall 生命周期更新。
- 飞书发送路径支持 Markdown card、图片、音频和文件，但媒体必须来自本地文件路径。
- 微信 iLink 接收路径当前规范化文本消息；发送路径支持文本、图片和音频，主动发送依赖已缓存的 `context_token`。
- Codex、skills、workers、桌宠和完整 Web 管理端仍是占位或规划中能力。
