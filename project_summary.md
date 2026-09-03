# Alice 项目结构总结

> 生成时间：2026-08-17。本文档是对当前仓库结构和各模块职责的高层总结，作为项目入口阅读材料；行为细节以 `src/` 源码与 `docs/` 为准。

## 1. 项目概述

Alice 是一个**本地优先的个人陪伴型 Agent 运行时**（TypeScript / Node.js）。核心是单进程 `ChatAgent`：接收多渠道（飞书、微信、WebRTC 语音）入站消息，解析为统一的 `AgentEvent`，通过 OpenAI 兼容 LLM 接口驱动多轮 function-call loop，把 `AgentOutput` 经输出路由器投递回对应渠道；并附带长期记忆（Memorize）、睡眠窗口、主动行为（heartbeat / initiative）、TTS/ASR 语音链路、管理后台等能力。

- 包名：`alice-companion-agent`，`type: module`，pnpm workspace 元数据保留但可用 npm 执行。
- 入口命令：`npm run dev:api`（构建后启动 API 进程）；`systemctl --user restart alice-agent-tmux.service` 用于重启服务。
- 管理后台：`http://127.0.0.1:3030/admin`（端口来自 `API_PORT`，默认 3030）。

## 2. 技术栈

| 方面 | 选型 |
|---|---|
| 语言/运行时 | TypeScript（ESM）、Node.js |
| 构建 | `tsc`（`tsconfig.build.json` / `tsconfig.api.json`） |
| 数据库 | `better-sqlite3`（SQLite，WAL） |
| LLM | 自研 OpenAI 兼容 `/v1` 客户端（Chat Completions / Responses + SSE 流式 + function tool calls） |
| 飞书 | `@larksuiteoapi/node-sdk`（WebSocket 事件订阅） |
| 微信 | iLink HTTP 长轮询（自研客户端） |
| WebRTC | `werift`（信令/媒体处理自研） |
| 语音编码 | `silk-wasm`、`ffmpeg-static` |
| 其他 | `date-holidays`（节假日）、`qrcode`、`shell-quote` |
| 测试 | `node:test` + `tsx`（串行），genie_tts 用 `python3 -m unittest` |

## 3. 顶层目录

```txt
Alice/
├── src/                 # 全部业务源码（见下）
├── tests/               # 测试，与 src 平行组织（apps/capabilities/channels/contexts/...）
├── apps/                # 几乎为空，仅遗留 apps/api/admin-ui/shell-order.json 副本
├── config/plugin/       # 每个插件的 config.json（photo/pi-worker/messaging/tts/asr 等）
│   └── plugin/tts/      # 另含 presets/ 与 providers/（genie/bailian/mimo/openai-api 等）
├── scripts/             # 一次性/运维脚本（见 §9）
├── infra/               # tmux + systemd 用户级自启脚本
├── docs/                # 当前文档 + archive/ 历史归档（规则见 docs/README.md）
├── assets/              # 本地资源（selfie 参考图、书橱 sqlite 等）
├── data/  logs/  memory-files/   # 运行时数据（.gitignore 排除或部分排除）
├── .env / .env.example  # 本地凭据与运行时配置（.env 不入库）
└── AGENTS.md            # 工程规则（本仓库强制规则）
```

## 4. 源码结构（src/）

```txt
src/
├── apps/api/            # 唯一应用进程：API / 管理后台 / 服务组装
├── contexts/            # 业务上下文（DDD 边界）
├── channels/            # 渠道插件（飞书/微信/语音/媒体）
├── capabilities/tools/  # LLM 工具插件（ToolPlugin）
├── capabilities/skills/ # 项目专有技能（SkillPlugin）
├── platform/            # 平台基础设施（config/time/storage/scheduler/output-router）
└── shared/              # 跨模块共享小工具
```

### 4.1 apps/api —— 应用进程与管理后台

- 入口链：`main.ts`（配置出站代理）→ `bootstrap/api-runtime.ts` → `bootstrap/api-root-runtime.ts`（总装 foundation/config/time/log、LLM runtime、piWorker、agent stack、server stack、control runtime）。
- `bootstrap/` 有 30+ 个 runtime 文件，按职责拆分：`api-foundation-runtime`、`api-llm-runtime`、`api-agent-stack-runtime`、`api-communication-runtime`（飞书/微信）、`api-control-runtime`、`api-admin-runtime`、`api-startup-runtime`、`admin-api-service.ts`（管理后台 API 主路由表，约 58 个分支）、`admin-runtime.ts`（渠道 start/stop/status/pairings/登录二维码）等。
- `server/`：`api-server-runtime`（http/https 双 server + 优雅关闭）、`api-lifecycle-runtime`（生命周期编排 + 每日调度）、`api-server-stack-runtime`（组合 communication/admin/lifecycle）、`api-https`（自签证书）、`env-file`（.env 持久化改写）、`http-shutdown`（socket 追踪式优雅关闭）、`singleton-lock`（单实例锁）。
- `middleware/http-utils.ts`：管理后台仅允许 loopback/私有网段（`admin_lan_only`）、JSON body 解析（64KB 上限）、`HttpJsonError` 契约。
- `routes/`：`admin-routes.ts` 顶层分发、`voice-call-routes.ts`（WebRTC 通话页）、`admin-http.ts`（统一错误处理）。
- `admin-ui/`：**无前端框架**，服务端 TS 函数生成单页 HTML/JS 字符串。8 个主 tab（Prompt、Shell、LLM Sessions/llm-chain、Token Usage、Memory、Plugin、Initiated Behaviors、Tool Preview）+ 侧栏（LLM Settings、Channel Settings、Alice Core、Agent Settings）。Plugin 页除运行时插件卡片外还提供独立 Credentials 管理入口，集中管理 API Key 与 OAuth 连接；LLM 侧栏只通过下拉框引用凭据。tab 与 script 一一对应（如 `tabs/memory.ts` + `memory-script.ts`）。

### 4.2 contexts —— 业务上下文

| 上下文 | 职责 |
|---|---|
| **agent-loop** | ChatAgent 核心。`createChatAgent`（policy 检查、session 解析、intent 路由、profile/tool 过滤）→ `createAgentLoopRuntime`（串行 requestRun、interrupt、activeMainLLMSession；**MainAgentActivity 占用模型**：`isMainAgentBusy()`/`beginClearSession()`，idle/running/clearing 三态，requestRun 与统一 clear 共用占用、busy 时互斥拒绝，clear 先获取占用、结束或失败后释放，run 内 clear 为 busy 连续交接无 idle 空窗）→ `buildChatAgentLoop`（function-call loop hooks）。Chat loop 持有两类独立的消息投递 reminder 状态：连续 6 次非发送类工具调用后追加一次 consecutive-tool user reminder；首次以 raw/空 content 静默结束且本轮没有成功调用发送类工具时追加一次 silent-ending user reminder；相同条件下首次调用 `Yield finish|await_chat` 时则将渲染后的 silent-ending reminder 作为该 Yield 的 tool error 返回，并移除本次 yield/清会话控制，不追加 user 消息。两类 reminder 在同一 turn 各最多一次，consecutive-tool 触发后仍可触发 silent-ending，再次静默允许结束。发送类按 ToolDefinition 工具级 `sendsMessage` 判断，当前 `Chat` 任意成功 action 均计为发送。raw assistant content 保持原样，不再重写为伪造 `Chat` tool call。心跳 `agent-heartbeat-runtime` 只做周期门控与非阻塞调度：每个 tick 至多发起一个 MainAgent 任务，任务 Promise 由所属 runtime 收尾；运行中 Chat 的消息插入通过通用 interrupt source 拉取内容，AgentLoop 不保存消息对象、ID、已读状态或 pending batch。Agent 状态机 `AgentStateController`（idle/waiting/calling/away/sleeping 等）同时提供普通 snapshot 变更和携带 previous/current 的精确状态跃迁；睡眠、唤醒副作用只订阅精确跃迁。进程重启续跑 continuation 存储。**无 index.ts**，出口在 `application/chat-agent.ts` 的 re-export |
| **memory** | 长期记忆/日记/睡眠 Memorize。`store.ts`（SQLite WAL，persistent/userPreferences/diary 表）、`induction.ts`（`runSleepMemoryInduction` 等，用独立 memory preset 的 LLM 跑归纳 loop）、`prompt-build`/`prompt-store`（三个 target 的归纳 prompt）、`self-talk-tool`（Memorize 私有思考工具 `self_talk`，不落盘）。Short Memory：`short-memory-store.ts`（主库 `alice.sqlite` 的 `short_memory_entries` 表：id/created_at/created_at_utc/content + 索引，统一 schema v10 幂等迁移，BEGIN IMMEDIATE 且每事务一次 insert，listLatest/listByCreatedAtUtcRange）、`short-memory-worker.ts`（`createShortMemoryWorker` 串行采集宿主 `~/.short_memory`：读取内容及重置前 mtime→校验 `/[\p{L}\p{N}]/u`→按同一 mtime 写入项目时区 `created_at` 与 UTC `created_at_utc`→原子 replace("\n")→commit，commit 失败补偿恢复原内容；`createHostShortMemoryFile` 按 `config.bashSandbox.hostWorkspaceDir` 映射容器路径并校验越界） |
| **llm-session** | LLM 会话管理。`sqlite-llm-session-store`（主库 `memory-files/llm-sessions.sqlite`：总表 `llm_session_meta` 六列只保存最终会话 meta，每 agent 类型 messages 分表三列保存唯一消息副本；schema v1 会移除旧 meta 中误存的完整 request/response 审计字段）、`llm-session-pointer`（`current.json` 仅 `{sessionId, agentType}`，原子写）、`llm-session-runtime`（ensure/note/clear/delta transcript，单一内存所有者，SQLite 事务失败内存不变；前缀校验、delta 与权威 transcript 使用 agent loop 的未清洗 messages，不持久化完整 LLM 请求/响应；进程内请求/响应日志只保留不含 message/raw payload 的轻量参数，管理后台按需从当前会话 messages 构造完整请求展示；`clearCurrentLLMSession` 异步，经统一清除协调器，`clearCurrentLLMSessionDirect` 供 Talk 回调内直接清除避免队列自等待）、浏览/列表/admin API、一次性迁移脚本 `scripts/migrate-llm-sessions-sqlite.ts`。`application/session-clear-coordinator.ts`：Chat/Talk/Memorize 三种会话清除统一串行协调入口（exists 执行时求值、Short Memory 采集成功后才清除、失败传播但队列继续，日志不记录正文） |
| **llm-gateway** | LLM 调用入口。`createOpenAICompatibleClient` 支持 Chat Completions，`createOpenAIResponsesClient` 将现有消息、图片与 function tool/tool result 映射到 Responses input，并把非流与 SSE 的文本、reasoning、工具增量和 usage 归一化回统一结果；Responses 音频输入明确拒绝。对话补全类调用统一经过 `llm-requests.ts` 的 send/buildTools 与共享消息归一化，不由消费者直连客户端；`llm-tool-loop.ts` 负责多轮 function-call loop（round/call 上限 100、continuation 恢复；通过 `tool-execution` context 执行已注册工具；模型调用未注册工具时写回同轮失败 tool result 并继续 loop）。LLM preset schema v2 以 `protocol + credentialId` 绑定协议和凭据，Chat/Talk/Memorize、图片识别、ASR、TTS 翻译与 OpenAI API TTS、Pi 均在调用时解析凭据；Memorize 的可用性只由已解析的 LLM client 决定，不再检查旧明文 API Key。OpenAI-compatible ASR 与 OpenAI API TTS 在 OAuth 401 后通过统一授权端口刷新并仅重放一次。`credential-store.ts` 使用 `memory-files/credentials.sqlite` 保存公开元数据与 AES-256-GCM 加密 payload，主密钥来自 `.env` 的 `ALICE_CREDENTIAL_MASTER_KEY`；API Key 与 xAI Device Code OAuth 共用该存储，OAuth 有提前刷新、单飞刷新、401 后按被拒 token 条件重试与 xAI origin 锁定，不回退其他认证。业务启动只打开已迁移的 schema v2 配置和凭据库，缺少主密钥时明确失败，不生成密钥、不执行迁移；仓库不保留迁移实现，`scripts/rollback-oauth-credential-migration.ts` 只提供基于加密快照的显式回滚。所有 OpenAI-compatible LLM 网络调用（包括 Pi relay 与 MiMo TTS）只经过 `llm-upstream-requester`；成功响应体消费完成时由该唯一 seam 产生一次调用事件，上层 Chat/Talk/Memorize/TTS/Pi 不写 LLM usage，也不解析价格，响应未返回 token 统计时仍保存 usage 事件；token 统计兼容 Responses 的 `input_tokens/output_tokens` 与 Chat 的 `prompt_tokens/completion_tokens`。Token Usage 的三个概念相互独立：usage 表只保存调用事实，不保存价格、Base URL 或 preset；每次 usage 触发 `models.dev/api.json` 整表的一小时过期检查，过期时懒更新并原子替换全部 provider、model 与完整上游 cost 对象，空或畸形响应不会覆盖最后一次成功表；同一次调用事件随后只用实际 Base URL 与模型匹配一次 `(provider, model)`。Pi relay 只负责 capability 鉴权与原生协议流转发，按 preset 仅开放 `/v1/chat/completions` 或 `/v1/responses`，snapshot 保存 `protocol + credentialId` 而不保存上游秘密；模型、stream、采样参数来自 preset。延迟 response transcript 在格式化后以显式关联 ID 提交，不依赖 request 对象身份；`scripts/backfill-token-usage-from-logs.ts` 可从保留的上游 SSE 原始日志按 model 与时间关联历史 usage，默认 dry-run，`--apply` 时以来源键幂等写入 |
| **tool-execution** | 通用工具执行上下文。`contracts.ts` 独立定义 `ToolDefinition`、`ToolCall`、`ToolResult`、`ToolPlugin`、执行上下文与 reporter 契约；`tool-execution-runtime.ts` 管理命名工具注册表、定义查询和统一 `ToolPlugin.execute` 路径，在执行前依据工具 JSON Schema 删除可选参数中的纯空白字符串（含嵌套对象和对象数组），使工具原有默认值生效，并统一驱动 execution reporter。`agent-loop` 与 `llm-gateway` 不再拥有工具契约、注册表或插件执行实现。 |
| **agent-profile** | Prompt 层管理。`domain/prompt-layer.ts` 为**唯一公共 layer 解析入口**（normalize、layer→LLMMessage、tool 参数解析）；`build-system-prompt.ts`（PromptProfile + build/append messages + layer 内嵌 tool call 回填 + staticPromptFingerprint）；PromptProfile 的 `consecutiveToolReminderLayer` 与 `silentEndingReminderLayer` 分别配置两类动态 user reminder，均只接受 user-role 消息，在管理后台独立编辑，运行时按条件注入而不属于初始/append prompt；`shell.ts`（每日 persona/relationship/outfit，`createDailyShellStore`；选项级 `enabled` 开关，关闭的选项不参与随机选中） |
| **talk-session** | WebRTC 语音 talk 会话。SQLite 适配器（`logs/talk/talk.sqlite`，talk_sessions/events/transcript/outputs）、`createTalkRuntime`（open/append/delta/interrupt/claim；`closeSession` 异步，经统一清除协调器，成功后按序：重写 Talk LLM transcript → 标记 LLM session cleared 并清 pointer → 关闭 talk.sqlite 会话 → conversation-hub 投影 → 切 waiting，采集失败时保持打开）、`createTalkRuntimeRuntime`（+ conversation-hub 投影，会话关闭转 inbound 消息） |
| **conversation-hub** | 多渠道消息统一入口。`createMessageRuntime`（ingestEvent/ingestLifecycle/appendAlbertMessage/sendSystemNotice/processNow/flushAll）内部组装 agentLoopRuntime + heartbeat 全部任务；普通入站只归一化并写入 SQLite，不调用 `noteInboundMessage`、不直接插入 Chat、也不额外调度 heartbeat。周期 heartbeat 以 SQLite 未处理消息为唯一 pending 来源；状态不可运行时先推进到期状态且仍不可运行则退出，可运行后登记 pending inbound，运行中同会话 Chat 由 `MessageRuntime` 持有 pending batch 并在 function-call loop 的真实插入点提供格式化文本，其他 MainAgent busy 状态直接退出；增量插入只结算 `coreProcessed`，`isRead` 仍只由真实 `Chat poll` 设置。Chat/Talk/Generated/pending loop 均由 heartbeat 非阻塞发起并由对应 runtime 异步收尾。force_wake 先获取 clearing 占用再清除、成功后才唤醒；`sqlite-conversation-store` 为 Core 侧消息历史 |
| **capabilities** | 插件 admin 运行时（asr/photo/tts/geo/image-recognition 等 admin-plugin-*）+ `tool-output-target.ts`（AgentOutput 投递目标解析器，产出 AgentOutput 的工具必须经此解析） |
| **initiative** | Agent 主动行为。initiated-behavior 定义、触发评估、随机事件、admin 配置、JSON 存储；`randomized` 行为 prompt 支持 `user` 与 `assistant` role |
| **prompt-context** | Prompt 模板变量渲染运行时（统一使用 `${{variable}}`，user/时间/dailyShell/memory/calendar/skills/notes_list/outfit 变量树）。未解析变量 warning 后保留原占位符，不再抛错；旧式 `{{variable}}` 作为普通文本。Short Memory 变量 `memory/shortMemory/content`：必填依赖 `shortMemoryStore`，取最新 wake boundary 的 `occurredAtUtc` 前 24 小时至当前的闭区间记录，输出 `<short_memories>` XML（`& < >` 转义，空结果固定空 XML），是否加入 Prompt layer 完全由用户 Prompt 编辑器配置决定 |
| **world-wanderer** | Google Street View 世界漫步空闲行为（移动 runtime、选路 policy、geo 计算）；选路优先近期未走过的有向 pano 边，当前出口的有向边全部耗尽时每次 idle 最多搜索一次附近可移动 pano，搜索失败则保留旧链接回退，因此兼容死路原路返回与小型 pano 环路脱困 |
| **bash-sandbox** | Docker 沙箱 bash 执行（`createBashSandboxRuntime` + `createDockerBashExecutor`、命令权限分类）；sandbox 容器由项目启动流程创建并保持运行，容器内 Pi worker 仍按 heartbeat/真实调用懒启动；codebase 挂载在启动配置时按 Git 可见树生成最小目录覆盖（只有含 ignored 子树时才继续拆分，仓库根 `.gitignore` 明确不挂载），并额外将整个 `memory-files/` 目录读写挂载；容器启动后将 mount cleanup 状态标记为 dirty，正常关闭时先停止容器、清理不再属于当前挂载集合的空 mount point，再标记 clean；下次启动会在状态缺失、dirty、mount key 变化或 container ID 变化时于容器启动前补做清理，当前挂载目标、非空路径和符号链接均保留；配置挂载覆盖 `tmpDir` 时跳过同路径 `tmpfs`，使宿主绑定的临时目录可通过容器路径映射读取并发送；`readSandboxNotesIndex` 通过既有容器路径→宿主挂载路径映射同步扫描笔记索引，返回容器路径供 prompt 变量动态构建，因此不依赖容器处于运行状态 |
| **pi-worker** | Pi worker 客户端（授权握手、后台唤起 wake、tool relay、健康轮询）；按 invocation 内最后一轮 assistant 终态判定 completed/failed，重试期间保留 running；SubAgent 对外使用持久化 nickname（来自 `runtime/pi-agent-names.txt`，空格替换为 `_`），映射写入 Pi session 根目录，池满时淘汰最早映射，worker 启动时清除 30 天前映射；内部 watcher 仍按真实 sessionId 读取状态；SubAgent 的 result/wait 返回完成 message 或运行/终态状态，messages 保留 access 语义并返回 Pi 原始 message；无效输入错误会指出未知 action、意外参数、缺失/无效字段等具体原因；未显式传入 timeout 时，SubAgent invocation 默认 6 小时超时；Read/Write/Edit/Bash 的 worker HTTP 错误仅向上抛出响应体中的具体 `error`，不再包装 tool 错误码和 HTTP 状态码 |
| **approval** | 基于飞书动态卡片的一对一审批服务（含卡片动作回调鉴权） |
| **skills** | 技能注册表/加载器/占位符/资源路径 |
| **agent-run-indicator** | Agent run 指示器抽象（begin/setTyping/fail）+ 飞书动态卡片与 tool 执行上报适配器。Tool execution reporter 持有一个与 session 无关的全局内存消息 ID 游标，每次 tool call 直接查询数据库中最新的已发送 assistant 消息或已读 user 消息 ID；未读 user 消息不参与分界。查询 ID 与内存游标不同时新建卡片并更新游标。游标初始为 null 且不持久化，重启后首个 tool call 新建卡片。工具执行卡片的创建、分组、更新和 streaming 设置不写系统日志 |
| **persona / wardrobe** | 纯类型与工具函数（persona 快照；outfit 选择/查找） |

Interrupt batch 由 `MessageRuntime` 管理，heartbeat 从 SQLite 找出当前 Chat 初始输入以外的新 pending 消息并加入 batch；AgentLoop 只通过 interrupt source 判断和拉取已格式化文本，不持有原消息信息。只有 function-call loop 到达真实插入点并拉取文本时才标记对应消息 `coreProcessed`，不会改变 `isRead`；真实执行 `Chat poll` 才标记已读并清空尚未插入的 batch。Yield 与 Interrupt 同时发生时，Yield 仅写入已包含 `Chat poll` 内容的恢复 tool result、丢弃对应 Interrupt 并继续同一 loop，不再重复插入 `<new_message>`。

无独立 index.ts 的 context：agent-loop、agent-profile、talk-session、initiative、capabilities（跨 context 直接引用内部路径）。

### 4.3 channels —— 渠道插件

| 渠道 | 职责 |
|---|---|
| **feishu** | 基于 lark SDK 的 WSClient（WebSocket 订阅 5 类消息/生命周期事件 + 卡片 action）。消息归一化为 `AgentEvent`；`senderName=core` 的 Markdown 出站消息使用用户提供的 Card JSON 2.0 DSL（grey header、`meeting-ai_filled` 图标、`core` 副标题），正文原样注入单一 Markdown 元素并使用普通 Markdown 默认字号；动态卡片（agent run indicator / tool execution，30KB 上限，四元素 ID）；`/pair alice` 单联系人配对；DM/群聊策略（disabled/open/allowlist/requireMention）；typing 用 reaction 模拟；`createFeishuPlugin` 总装 |
| **wechat** | iLink `getupdates` 长轮询 + cursor 持久化；登录二维码扫码；图片走 CDN AES-128-ECB 加密上传，音频 ffmpeg+silk-wasm 转 SILK；出站仅 text/image/audio，需联系人 contextToken；状态 JSON 文件（`memory-files/indexes/wechat-ilink-state.json`） |
| **webrtc-voice** | 自研 WebSocket 信令（offer/ICE/speech-state/interrupt/hangup 等）；两个 peer 实现（werift 进程内 / fork 媒体处理子进程）；`createCallState` 通话状态机 + interrupt epoch + TTS producer 输出 pump + 播放队列；ffmpeg 转 Opus RTP 帧；浏览器测试页 |
| **tts** | 多 provider 路由（router）：转换 provider（OpenAI API/Bailian 百炼/Mimo）+ 本地服务（MOSS 8765 voice-clone、Genie 8767 stream 模式）；LLM 翻译后合成；流式合成与文本切块；preset 体系（core/shell/edit 四档）；纯符号输入返回静音 PCM |
| **asr** | 转写分发（tencent / multimodal_llm / openai_compatible）；ffmpeg 静音检测切分；伪流式会话（1.5s 长暂停 flush partial）；腾讯实时 WebSocket 流 |
| **image-generation** | 自拍图片生成（gateway 全局并发 2）：OpenAI `images/edits` 表单、xAI Grok Imagine `images/edits` JSON（最多三张 data URI 参考图、`b64_json` 响应）与 codex runner 三种模式；xAI 模式通过 `selfieXaiCredentialId` 动态解析统一 API Key/OAuth 凭据，并复用 OAuth 401 刷新语义；产物校验（扩展名白名单、路径防护、JPEG 归一化）。**无插件对象**，纯函数库 |
| **image-recognition** | 单文件纯函数：多模态 LLM 识别图片（base64 data URL 内联，不落盘），固定错误码集合。无插件对象 |
| **google-streetview** | 完整插件：坐标元数据/街景图（半径递增搜索）、pano graph、随机取点；pano 落盘复用；region/随机点/坐标 bucket 地理工具 |

### 4.4 capabilities/tools —— LLM 工具插件

全部为 `createXxxTools(deps): ToolPlugin` 工厂（契约 `id + listTools + execute` 定义在 `agent-loop/src/contracts/agent-contracts.ts`）。工具暴露给 LLM 由 **`toolNames`** 决定：chat-agent 先 `filterVisibleTools(allToolPlugins, promptProfile)` 按 prompt profile 过滤，再把可见工具名注入 LLM request。

| 工具 | Tool 名 | 职责 |
|---|---|---|
| messaging | `Chat` | 查看聊天记录 / 发送消息（text/markdown/image/voice/file）；`mapMarkdownLikeToMarkdown` 开启时，飞书纯文本消息包含 Markdown 特征或规范化后超过 3 行会自动转为 Markdown；`today` 比较“睡眠茧时间点前最后 10 条消息”与“最后一条 Short Memory 写入时间前最后 10 条消息”的窗口起点并取较晚者，无睡眠茧时以今日锚点参与比较 |
| photo | `Selfie` | 自拍（pose 必填，expression、hair、composition 为可选参数；未提供时使用 Photo 配置 Main Prompt 分组的默认值，其中 expression/hair 分别自动加上“表情: ”/“发型: ”和换行，composition 默认使用“镜头距离为超近景, 一臂距离, 人物占画面80%以上”；四个 Selfie prompt 变量位于 `selfie` 父节点下；`returnImageToLLM` 默认关闭，开启后且模型支持图片时才回传图片附件；生成器实际产出的全部图片逐张发送、入库；失败后同一 agent loop 30 秒内阻止重试，超时自动允许；不再发送拍照中/失败系统通知） |
| calendar | `calendar` | 日历增删查搜 + 上下文渲染（SQLite CalendarStore） |
| shell | `Bash` | 沙盒 bash 执行（透传 PiWorker） |
| file | `Read`/`Write`/`Edit`/`Glob` | 文件读写改查（图片转 llmFollowupAttachments） |
| location | Panorama | 街景与世界漫游：current 查看当前位置/send 将当前 pano 图片经统一输出目标发送并入库（不标记 `sendsMessage`）/teleport 传送重置轨迹/navigation 设导航目标 |
| restart | `restart` | 重启 Alice 服务（systemd） |
| subagent | `SubAgent` | 持久化 SubAgent 会话（spawn/messages/result/send/status/wait/cancel/fork，走 PiWorker；公开会话标识使用 nickname，messages 保留 access 语义并返回 Pi 原始 message） |
| skills | `Skill` | 按名称加载技能（XML 输出） |
| dice | `Dice` | 投骰子 |
| sleep-cocoon | `sleep_cocoon` | 睡眠茧：in 钻进入睡（随机 ±15 分钟）/ out 取消；不再发送就寝/起床系统通知 |
| bookcase | `Bookcase` | 书橱抽书讲故事 / 还书（assets/tools/bookcase/booksummaries.sqlite） |
| wardrobe | `Wardrobe` | 查看/切换服装（list/mirror/switch/random，可触发 on-body 生成；不再发送更衣系统通知） |
| finish-and-wait | `Yield` | 等待、清空上下文或结束：clear 清除当前 LLM 对话并在同一 loop 开启新一轮，同时追加仅供 Core/Albert 使用的 `<Alert info="上下文历史已清空" />`；await_chat 固定等待 15 分钟；schedule（10s–15min 定时返回）实现保留但不在 profile 中暴露；连续 schedule 且无 subagent 运行时拒绝（防空转） |

`Yield`、`SubAgent`、`Panorama` 的 tool 输入 schema 使用 `action` 字符串 `enum` 与可选参数；各 action 的实际参数要求仍由工具执行层校验，不使用 `oneOf`。`Panorama.send` 只是发送当前 pano 图片的 helper action，工具定义不设置 `sendsMessage`，因此 agent loop 不会将其计为已完成用户消息回复。


结构约束：
capabilities/tools/{tool name}/
├── src/                          # 业务代码
│   ├── index.ts                  # 导出 createXxxTools(deps): ToolPlugin 工厂（契约 id + listTools + execute）
│   └── *.ts                      # 复杂工具按需拆分（config.ts / types.ts / tool-runtime.ts 等）
├── profile.ts                    # 纯静态声明：ToolDefinition（name/description/inputSchema/passRenderText/suppressExecutionCard）
│                                 #   + 工具名常量 + 描述常量 + 提示/报错/警告/系统提示文本常量
│                                 #   可被 chat-agent / admin-api 等跨模块直接引用（如 restartToolName）
└── README.md                     # 可选：工具行为说明（photo / subagent / bookcase 有）

配套路径：总装在 `messaging/src/tool-runtime.ts`（逐一 `createXxxTools` 组装）；测试在 `tests/capabilities/tools/{tool name}/`。

实现约束：
- 已暴露的 tool call 必须走统一 ToolPlugin.execute 路径，结果写回同一 function-call loop；`requester` 仅表示调用来源。
- 产出 AgentOutput 的工具必须经 capabilities 层 tool-output-target 解析投递目标，不得自行决定渠道。
- 工具返回无须包含无关元数据，也不得带 render 层渠道格式。
- description 是 LLM 可见的工具接口，遵循 tool_description_guideline.md（不重复 inputSchema、无需暴露实现细节）。

### 4.4.c capabilities/skills —— 项目专有技能

first-party skill 位于 `capabilities/skills/{name}/SKILL.md`（frontmatter 含 `name` / `description`），由 skills 注册表扫描（每次访问实时重扫），自动出现在 `${{system_skills}}`，经 `Skill` 工具按名称加载；加载时只展开 `${{variable}}`，未解析变量和旧式 `{{variable}}` 保持原文。现有内置技能：

| Skill | 职责 |
|---|---|
| list-installed-skills | 列出已安装的 third-party skills（`${{installed_skills}}` 动态构建） |
| list-notes | 列出 sandbox 中 `~/.agents/notes` 下的笔记（`${{notes_list}}` 加载时动态构建 name / description / path；笔记文件带同名 frontmatter，目录在 sandbox 容器内） |

### 4.5 platform 与 shared

- `platform/config`：环境变量解析（envBool/envNumber/envJsonObject）。
- `platform/time`：全局时间提供器（`createCurrentTimeProvider`），时区来自 `AGENT_TIMEZONE`（默认 Asia/Singapore），统一输出配置时区 wall-clock ISO。
- `platform/storage`：`calendar-store`（holiday/birthday/schedule）、`diary-store`（日记 + 睡眠边界）、`token-usage-store`、`sqlite-compat`（better-sqlite3 薄封装）、`admin-asset-utils`（资源路径安全校验）。
- `platform/scheduler`：`createDailyScheduler` 每日定时调度器。
- `platform/output-router`：按 `output.target.plugin` 注册/路由 `ChannelSender`。
- `shared/errors`（describeError、formatErrorNotice）、`shared/admin-input`（管理后台输入校验）、`shared/clock`（CurrentTimeProvider 契约）、`shared/uuid`（createId）。

## 5. 核心运行时流程

### 5.1 聊天 loop（chat）

1. 渠道收到消息 → 归一化为 `AgentEvent` → `createMessageRuntime.ingestEvent` 只写入 conversation-hub SQLite；周期 heartbeat 后续发现未处理消息。
2. ChatAgent `prepareEventRun`：policy 检查（配对/allowlist/睡眠等）→ session 解析 → intent 路由 → prompt profile + `filterVisibleTools` 过滤 → 组装 LLM session。
3. `runLLMToolLoop`（llm-gateway）多轮 function-call loop：LLM request（toolNames 注入）→ tool call 经统一 `ToolPlugin.execute` 执行 → tool result 写回同一 loop → 直到产生 `AgentOutput`。
4. `AgentOutput` 经 `tool-output-target` 解析投递目标 → output-router → 渠道 send（飞书 renderer / 微信 / TTS 语音）。

### 5.2 心跳与主动行为（heartbeat）

`agent-heartbeat-runtime.runHeartbeatTasks` 每秒运行一次门控与调度：不可运行状态先尝试到期跃迁，仍为 sleeping/away 等状态就退出；随后由 `MessageRuntime` 根据 SQLite pending 更新 `noteInboundMessage`，若存在运行中同会话 Chat 则仅补充其 pending batch 并退出，其他 MainAgent busy 状态也退出。空闲时依次检查失败 session 重试、idle timer transition、randomized initiated behavior、timed yield（Yield 工具 schedule 到期）、talk session、sleep cocoon wake/goodnight、calendar reminder和 pending session；每个 tick 至多发起一个 MainAgent 任务且不等待 loop 完成。最近一次 Chat Agent session 请求失败时会保留失败事件；若同一会话随后到达新的 pending 消息，下一次 dirty-session 处理会沿用失败 request 的 LLM transcript，并仅追加失败事件尚未携带的消息；该次请求再次失败时这些消息保持 pending，后续原样重试而不重复 append，成功后才标记已处理。没有新 pending 消息时，`waiting` 状态切换到期后先发起同一 session 的重试并退出本次 tick；成功请求清除失败事件，LLM 请求结束仍通过既有 settlement 路径重置状态切换倒计时。

### 5.3 睡眠记忆归纳（Memorize）

睡眠窗口内对当天消息跑记忆归纳 loop：persistent（长期偏好）→ userPreferences → yesterdaySummary 三个 target，写入 `alice.sqlite` 的 long-term-memory / diary 表；失败通知沿用 `formatErrorNotice` 输出具体错误 title/message，不包含 JSON 或 traceback；`self_talk` 私有思考工具只记录不落盘。

## 6. 数据存储

| 数据 | 位置 |
|---|---|
| 长期记忆/日记/Core 侧消息历史/Short Memory | `memory-files/alice.sqlite`（long-term-memory / diary / persistent / userPreferences / `short_memory_entries`） |
| 追加式消息事件/调试日志 | `logs/message/message-logs.sqlite` |
| talk 语音会话 | `logs/talk/talk.sqlite` |
| LLM 会话（chat/talk/memorize） | `memory-files/llm-sessions.sqlite`（总表 + agent messages 分表） |
| LLM API Key / OAuth 凭据 | `memory-files/credentials.sqlite`（公开元数据 + AES-256-GCM 加密 payload） |
| SubAgent 会话 | `memory-files/llm-subagent-sessions.sqlite` |
| Pi session 与 nickname 映射 | `memory-files/pi-sessions/pi-agent-nicknames.json`（Pi worker 的 session 根目录） |
| LLM 会话 current 指针 | `memory-files/llm-sessions/current.json`（仅 `{sessionId, agentType}`） |
| 旧 JSONL 会话归档（一次性迁移后） | `memory-files/llm-sessions-jsonl-legacy-*`（运行时不再访问） |
| 系统日志（保留 7 天） | `logs/system/` |
| 飞书配对 | `memory-files/indexes/feishu-paired-contacts.json` |
| 微信 iLink 状态 | `memory-files/indexes/wechat-ilink-state.json` |
| 每日 shell（persona/outfit） | `memory-files/shell/` |
| Short Memory 宿主暂存文件（sandbox 容器内 `~/.short_memory`） | 宿主 `path.join(config.bashSandbox.hostWorkspaceDir, ".short_memory")`，默认 `.sandbox/bash/alice/.short_memory` |
| 插件配置 | `config/plugin/*/config.json` |

约定：`logs/` 下数据为系统日志，不进入 LLM 上下文；清理聊天历史只清 Core 侧消息表，不清日志库（除非明确是清系统日志）。

## 7. 管理后台

- URL：`http://127.0.0.1:3030/admin`，仅允许 loopback/私有网段访问。
- 单页 HTML 由服务端 TS 字符串渲染（无框架、无构建）。
- API 覆盖：prompt/shell 管理、memory（含 run-day/undo/redo、Short Memory 只读区块最新 100 条）、LLM 会话浏览（llm-chain）、token usage、logs、插件配置（`/admin/api/plugins`，9 个插件条目）、渠道（飞书/微信 start/stop/pairings/二维码）、agent state、TTS/ASR/photo/geo 配置，以及 API Key 新增/删除、xAI Device Code OAuth 连接/轮询/断开和无秘密凭据列表。仍被 preset 或照片配置引用的凭据不能删除；管理后台 LLM preset 编辑器只选择协议与 credentialId，不读取或回传秘密。
- `GET /admin/api/memory` 响应含 `shortMemories`（最新 100 条，`createdAtUtc DESC, id DESC`，同时返回本地 `createdAt` 与 UTC `createdAtUtc`）。
- `POST /admin/api/llm-chain/clear`、`POST /admin/api/llm-run/cancel`（实际 clear 阶段）、`POST /admin/api/memory/clear-session` 均等待异步清除并返回 `{ ok, cleared, shortMemoryCaptured }`；无会话返回 `cleared: false`，失败走统一 JSON 错误。
- 管理后台改动的设置必须持久化到 `.env` 且当前进程立即应用。

## 8. 部署与运维

- 本地运行：`npm run dev:api`；重启：`systemctl --user restart alice-agent-tmux.service`。
- `infra/start-agent-tmux.sh`：管理 tmux session，stop 时同时停止 Docker bash sandbox 容器。
- `infra/install-user-systemd-autostart.sh`：安装用户级 systemd 服务（oneshot + RemainAfterExit）并 enable-linger 开机自启。
- 单实例锁：`state/<name>.lock` 目录 + pid 文件，防重复启动。

## 9. 脚本（scripts/）

- `backfill-sleep-memory.ts`：一次性回填睡眠记忆。
- `migrate-llm-sessions-sqlite.ts`：一次性把 JSONL 会话归档迁移到 SQLite 主库与 SubAgent 独立库（逐文件逐行导入、拒绝覆盖、独立校验、legacy 目录改名保留源文件）。
- `seed-calendar-holidays.ts`：用 date-holidays 写入节假日到日历表。
- `test-selfie-image-api.mjs`：自拍图片 API 独立测速。
- `update-photo-pngfile-to-jpg.mjs`：一次性 PNG→JPG 迁移。
- `webrtc-voice-demo-server.mjs`：独立 HTTPS 语音通话演示服务（默认 3041）。
- `genie_tts/`（service.py / official_server.py / benchmark）、`moss_tts_onnx/`（ONNX CPU 本地 TTS 服务）。

## 10. 测试

- 位置 `tests/`，与 src 平行组织（apps/capabilities/channels/contexts/helpers/infra/platform/scripts）。
- `node:test` + `node:assert/strict`，`npm test` 用 tsx 串行运行；genie_tts 用 python unittest。
- 风格：每域 `*-helpers.ts` 共享夹具；行为断言（状态码/错误码/stdout）而非固定输出格式。
- Short Memory 相关：`short-memory-store.test.ts`、`short-memory-worker.test.ts`、`session-clear-coordinator.test.ts`、`llm-session-runtime-session-clear.test.ts`、`agent-loop-runtime-session-clear.test.ts`、`chat-agent-session-clear-wait.test.ts`、`talk-session-close-session-clear.test.ts`、`memory-console-session-clear.test.ts`、`admin-routes-clear-api.test.ts`、`prompt-context/short-memory-variable.test.ts`，以及 `admin-routes-memory.test.ts` / `admin-html-memory-shell.test.ts` 的 Short Memory 扩展用例。

## 11. 文档约定

- `docs/` 按主题分目录（core/channels/capabilities/app/architecture/implement/plan/reference + archive 历史归档），规则见 `docs/README.md`：当前文档用中文并指向 `src/`、`tests/` 路径；`archive/` 不是当前行为规范。
- 本文档只记录已经实现且能由当前源码验证的项目结构与行为；未开发的需求、计划、设计和待办禁止写入。实际实现完成后才同步更新本文档，仅新增或修改计划文档时不得更新。
- 变更说明在 `docs/change_log/`（时间戳命名）。
- 根级 `AGENTS.md` 为工程强制规则（prompt 构筑硬约束、Tool/Loop 硬约束、review checklist 等）。
