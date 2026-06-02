# 飞书 Channel Plugin 现状分析

本文档整理当前飞书 plugin 已完成内容、实现方式和待完成部分。分析范围包括 `plugins/feishu`、`apps/api` 的接线、通用 messaging tool、消息存储与现有测试。

## 当前定位

飞书是 Alice 的 Channel Plugin，负责把飞书/Lark 消息接入 AgentCore，并把 Agent 输出发回飞书。它不是独立工具 plugin；Agent 与管理后台使用的是平台无关的 messaging 能力，再通过 target 路由到飞书。

当前主路径是：

```text
飞书 WebSocket 事件
  -> plugins/feishu 规范化、配对、策略、去重
  -> apps/api messageRuntime 入库和调度
  -> AgentCore
  -> outputRouter / messaging tool
  -> plugins/feishu 出站渲染和发送
```

## 已完成内容

### 连接与运行时

- 已使用 `@larksuiteoapi/node-sdk` 创建飞书 `Client` 和 `WSClient`。
- 已支持 WebSocket 事件订阅，启动后注册 `im.message.receive_v1` 文本消息事件。
- 已支持 `start()` / `stop()` 幂等控制；管理后台可通过 `/admin/api/plugins/feishu/start` 和 `/admin/api/plugins/feishu/stop` 控制运行时。
- 管理后台可保存 `FEISHU_ENABLED`、`FEISHU_CONNECTION_MODE`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_REQUIRE_MENTION` 到 `.env`。
- API 进程启动时创建飞书 plugin、注册到 AgentCore，并把飞书事件交给 `messageRuntime`。

### 入站文本消息

- 已把飞书文本消息转换为统一 `AgentEvent`。
- 已解析飞书文本 `content` JSON 中的 `text` 字段。
- 已根据 `chat_type` 区分 DM 与群聊。
- 已生成稳定会话 id：
  - DM: `feishu:dm:<key>`
  - 群聊: `feishu:group:<key>`
  - thread 存在时优先用 `thread_id` 作为会话 key。
- 已处理 mention token，进入 AgentCore 前会从正文中移除飞书 mention key。
- 已记录 `receivedAt` 和 `receivedAtUtc`，用于消息库和调试日志。
- 已把入站消息 upsert 到 SQLite `messages`，并把会话标记为待处理。

### 入站消息支持范围

当前入站支持要和出站支持分开看。飞书 plugin 现在只把文本消息作为可触发 AgentCore 的用户消息处理：

| 飞书入站类型 | 当前状态 | 处理方式 |
| --- | --- | --- |
| 文本消息 | 已支持 | 通过 `im.message.receive_v1` 接收，解析 `content.text`，转换为 `type="message.text"`、`payload.kind="text"` 的 `AgentEvent`。 |
| DM 文本 | 已支持 | `chat_type="p2p"` 时进入 DM 会话，默认需要先完成唯一配对。 |
| 群聊文本 | 部分支持 | 可解析为 group 会话；默认要求 mention，且当前默认 `groupPolicy=allowlist`、allowlist 为空，需要配置放行后才会进入 AgentCore。 |
| thread 文本 | 部分支持 | `thread_id` 会参与 session id 生成，但没有单独实现 thread 回复上下文、引用链或按 thread 发回复。 |
| mention 文本 | 已支持 | 识别 `mentions`，并把 mention key 从正文里移除；策略可要求群聊必须 mention。 |
| reaction 创建/删除 | 状态事件支持 | 不作为用户消息触发 AgentCore，只更新已有消息的 reaction 状态并写 message log。 |
| 已读回执 | 状态事件支持 | 不作为用户消息触发 AgentCore，只更新已有消息的 read 状态并写 message log。 |
| 撤回事件 | 状态事件支持 | 不作为用户消息触发 AgentCore，只更新已有消息的 recall 状态并写 message log。 |
| 图片入站 | 未支持 | 出站可发图片，但入站图片还没有下载、资产入库或转换为 `AgentEvent`。 |
| 语音/音频入站 | 未支持 | 出站可发音频；入站音频还没有下载、ASR 或文本化链路。 |
| 文件入站 | 未支持 | 出站可发文件；入站文件还没有下载、资产入库或摘要/解析链路。 |
| 富文本/post/card/sticker 等 | 未支持 | 还没有按飞书消息类型分别解析为统一消息 payload。 |

### 去重与异步处理

- 已实现近期消息去重，重复 `message_id` 会在进入 AgentCore 前被忽略。
- 入站消息不会阻塞飞书事件回调；插件会把实际 Agent 处理放入异步队列。
- 已有测试覆盖重复消息忽略，以及慢 Agent 处理不阻塞 `ingestTextMessage()` 返回。

### 配对与访问策略

- 默认 DM 策略是 `pairing`。
- 已支持 `/pair alice` 唯一配对命令；命令可通过 `FEISHU_PAIRING_COMMAND` 覆盖。
- 配对信息保存到 `memory-files/indexes/feishu-paired-contacts.json`。
- 当前只允许一个飞书联系人成为主动消息默认目标；已有绑定后，其他联系人配对会被拒绝。
- DM 支持 `disabled`、`open`、`allowlist`、`pairing` 策略。
- 群聊支持 `disabled`、`open`、`allowlist` 策略。
- 群聊默认要求 mention，未 mention 时会被策略拒绝。

### 消息生命周期事件

已订阅并规范化以下飞书生命周期事件：

- `im.message.reaction.created_v1`
- `im.message.reaction.deleted_v1`
- `im.message.message_read_v1`
- `im.message.recalled_v1`

这些事件不会作为新消息交给 AgentCore，而是交给 `messageRuntime.ingestLifecycle()`：

- reaction 更新消息的 reaction JSON。
- read 更新 `is_read`、`read_at`、`read_at_utc`。
- recall 更新 `is_recalled`、`recalled_at`、`recalled_at_utc`。
- 每个生命周期事件也会写入追加式 message log，便于调试。

### 出站发送

已支持把 `AgentOutput` 渲染为飞书发送计划：

- `text` -> 飞书文本消息。
- `markdown` -> 飞书 interactive card，卡片内使用 markdown element。
- `card` -> 先转为 markdown，再按 interactive card 发送。
- `image` -> 上传本地 assets 下图片，再发送图片消息。
- `audio` -> 上传本地 opus 文件，再发送音频消息。
- `file` -> 上传本地文件，再发送文件消息。

target 解析规则：

- 有可用 `channelId` 时按 `chat_id` 发送。
- 否则使用 `userId` 或 `channelId` 推导 `open_id`。
- 支持解包内部 id，例如 `feishu:dm:oc_xxx`。
- 媒体文件路径必须位于项目 `assets` 目录下；`file://` 和越界路径会被拒绝。

### 通用聊天工具接入

AgentCore 暴露的是通用工具，不是飞书专用工具：

- `check_chat`
- `search_messages`
- `send_chat`

兼容工具名仍存在：

- `check_feishu`
- `send_feishu`

当前行为要点：

- `check_chat` 读取消息历史和未读上下文，并把读到的用户消息标记为已读。
- `search_messages` 当前按目标 plugin 搜索，不按具体飞书会话强过滤。
- `send_chat` 支持文本、markdown、图片和 voice 模式。
- voice 模式会先用默认 TTS 后端生成 opus，再通过飞书音频发送；对飞书还会发送括号包裹的 transcript 文本。
- 发送失败会写入失败状态，并进入内存 retry queue，最多重试 3 次。

### 管理后台

已提供以下飞书相关接口：

- `PUT /admin/api/config/feishu`
- `GET /admin/api/plugins/feishu/status`
- `POST /admin/api/plugins/feishu/start`
- `POST /admin/api/plugins/feishu/stop`
- `GET /admin/api/plugins/feishu/pairings`
- `POST /admin/api/plugins/feishu/test-markdown`
- `POST /admin/api/plugins/feishu/test-image`
- `POST /admin/api/plugins/feishu/test-audio`

后台 UI 已有 Feishu 设置表单、启停按钮、运行状态展示、pairing 列表读取，以及测试发送入口。

### 测试覆盖

已有测试覆盖重点包括：

- 飞书 message id 去重。
- 慢 Agent 处理不阻塞飞书入站 ingest。
- 消息生命周期对 SQLite 消息状态的更新。
- messaging tools 在飞书 target 下的收发、搜索、失败日志、retry、voice transcript 和 id 规范化。
- 管理后台接口基础上下文中包含飞书 plugin 和 pairing store。

## 实现方式

### 核心模块

| 文件 | 职责 |
| --- | --- |
| `plugins/feishu/src/index.ts` | plugin 入口，组合 monitor、策略、配对、去重、出站发送。 |
| `plugins/feishu/src/client.ts` | 封装 Lark SDK、WebSocket 订阅、消息发送、图片/文件上传。 |
| `plugins/feishu/src/monitor.ts` | client facade，供入口层统一 start/stop/send。 |
| `plugins/feishu/src/handlers/message.ts` | 飞书文本事件到 `AgentEvent` 的转换。 |
| `plugins/feishu/src/handlers/lifecycle.ts` | reaction/read/recall 事件规范化。 |
| `plugins/feishu/src/pairing.ts` | 唯一联系人配对和持久化。 |
| `plugins/feishu/src/policy.ts` | DM/群聊访问策略。 |
| `plugins/feishu/src/renderer.ts` | `AgentOutput` 到飞书发送计划的转换。 |
| `plugins/feishu/src/dedupe.ts` | 近期消息去重。 |
| `apps/api/src/index.ts` | 创建飞书 plugin，接入 `messageRuntime`、AgentCore 和管理后台上下文。 |
| `apps/api/src/admin-routes.ts` | 飞书配置、启停、状态、pairing 和测试发送 API。 |
| `apps/api/src/message-runtime.ts` | 入站消息入库、生命周期事件落库、会话调度。 |

### 数据流

入站文本：

```text
WSClient receive_v1
  -> wrapLarkMessageEvent()
  -> textMessageEventToAgentEvent()
  -> createRecentMessageDeduper()
  -> pairing command / checkFeishuEventPolicy()
  -> messageRuntime.ingestEvent()
  -> message_logs + messages
  -> pending session
```

生命周期：

```text
WSClient lifecycle callback
  -> reaction/read/recall normalizer
  -> messageRuntime.ingestLifecycle()
  -> message_logs
  -> messages 状态字段更新
```

出站：

```text
AgentOutput
  -> outputRouter 或 messaging tool
  -> feishu.send()
  -> renderForFeishu()
  -> monitor.send*
  -> Lark client im.v1.message.create / file.create / image.create
```

### 配置来源

运行时配置来自 `loadConfig()` 解析环境变量：

| 环境变量 | 用途 |
| --- | --- |
| `FEISHU_ENABLED` | 是否启用飞书。 |
| `FEISHU_CONNECTION_MODE` | 连接模式，当前实际可用是 `websocket`。 |
| `FEISHU_APP_ID` | 飞书应用 app id。 |
| `FEISHU_APP_SECRET` | 飞书应用 app secret。 |
| `FEISHU_REQUIRE_MENTION` | 群聊是否要求 mention。 |
| `FEISHU_PAIRING_COMMAND` | 覆盖默认配对命令。 |
| `AGENT_DEFAULT_TARGET_PLUGIN` | 主动消息默认目标，可设为 `feishu`。 |

配置结构中存在多账号、webhook、allowlist 和 codexPolicy 字段，但当前后台主要维护 main 账号和基础启停/mention 配置。

## 待完成部分

### 高优先级

- webhook 模式尚未实现。配置允许 `webhook`，但 client 启动时只接受 WebSocket，选择 webhook 会抛出错误。
- 多账号尚未真正接入。配置类型支持 `accounts`，实际发送和事件处理基本固定使用 `main` 或第一个账号。
- 入站消息类型只完成文本。图片、语音、文件、富文本、卡片、引用消息、thread 回复内容还没有完整规范化为 Agent 可消费的事件。
- 出站 `replyTo` 已存在于发送计划，但发送实现没有使用飞书 reply/thread API，因此目前不是严格的“回复原消息”。
- 群聊 allowlist 配置没有后台编辑入口；默认 `groupPolicy=allowlist` 且列表为空，群聊实际需要额外代码或配置扩展才能放行。
- `codexPolicy` 字段已在配置里存在，但当前飞书策略检查未使用它。

### 中优先级

- lifecycle 事件只按 `externalMessageId` 更新已有消息；如果事件先于消息到达，或没有匹配行，只会记录日志，不会建立延迟关联。
- pairing store 只保存一个联系人，适合个人 Agent；如果要支持多个联系人、多群或多租户，需要重新设计 target 选择和权限模型。
- session binding 是内存 Map，重启后会按同样 key 重新推导，但没有独立持久化绑定元数据。
- 搜索消息当前按 plugin 过滤，不按具体飞书 session 精确过滤；多会话场景下需要增强查询条件。
- 飞书 API 错误没有统一成稳定错误码；部分错误信息会直接从 SDK 或调用层进入日志。
- 媒体上传只支持本地 `assets` 路径，缺少从远程 URL、临时文件或外部 asset store 到飞书上传的统一资产接口。
- audio 发送依赖本地 opus 文件；还没有在飞书侧做格式能力检测或失败降级。

### 低优先级

- markdown 当前通过 interactive card 的单个 markdown element 发送，还没有完整卡片模板、按钮、分栏或主题样式。
- 管理后台的 Feishu 设置页比较基础，缺少权限策略、allowlist、配对解除、测试接收和诊断面板。
- 没有端到端飞书沙箱测试；现有测试主要覆盖规范化、存储、tool 行为和模拟发送。
- 日志已有 raw JSON 记录，但缺少按飞书 event id、message id、session id 聚合的诊断视图。
- 配对命令只有精确匹配，不支持大小写、空白容错或后台可视化配置。

## 当前可用结论

飞书已经具备个人 Agent 的基础可用链路：WebSocket 收文本、唯一用户配对、DM 权限控制、消息入库、AgentCore 调度、通用聊天工具、文本/markdown/图片/音频/文件出站，以及 read/reaction/recall 状态更新。

它还不是完整的飞书平台集成。当前实现更适合作为单用户或受控小范围测试渠道；要进入多用户、多群、富媒体入站或生产级运维场景，需要优先补 webhook/多账号/非文本入站/权限后台/端到端诊断。
