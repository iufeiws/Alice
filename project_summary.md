# Alice 项目结构总结

> 生成时间：2026-08-13。本文档是对当前仓库结构和各模块职责的高层总结，作为项目入口阅读材料；行为细节以 `src/` 源码与 `docs/` 为准。

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
| LLM | 自研 OpenAI 兼容 `/v1` 客户端（chat/completions + SSE 流式 + function tool calls） |
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
- `admin-ui/`：**无前端框架**，服务端 TS 函数生成单页 HTML/JS 字符串。8 个主 tab（Prompt、Shell、LLM Sessions/llm-chain、Token Usage、Memory、Plugin、Initiated Behaviors、Tool Preview）+ 侧栏（LLM Settings、Channel Settings、Alice Core、Agent Settings）。tab 与 script 一一对应（如 `tabs/memory.ts` + `memory-script.ts`）。

### 4.2 contexts —— 业务上下文

| 上下文 | 职责 |
|---|---|
| **agent-loop** | ChatAgent 核心。`createChatAgent`（policy 检查、session 解析、intent 路由、profile/tool 过滤）→ `createAgentLoopRuntime`（串行 requestRun、interrupt、activeMainLLMSession；**MainAgentActivity 占用模型**：`isMainAgentBusy()`/`beginClearSession()`，idle/running/clearing 三态，requestRun 与统一 clear 共用占用、busy 时互斥拒绝，clear 先获取占用、结束或失败后释放，run 内 clear 为 busy 连续交接无 idle 空窗）→ `buildChatAgentLoop`（function-call loop hooks）。心跳 `agent-heartbeat-runtime`：idle transition、randomized initiative、timed yield、talk session、sleep cocoon、calendar reminder、pending session，全部受 canRunHeartbeat 门控。Agent 状态机 `AgentStateController`（idle/waiting/calling/away/sleeping 等）。进程重启续跑 continuation 存储。**无 index.ts**，出口在 `application/chat-agent.ts` 的 re-export |
| **memory** | 长期记忆/日记/睡眠 Memorize。`store.ts`（SQLite WAL，persistent/userPreferences/diary 表）、`induction.ts`（`runSleepMemoryInduction` 等，用独立 memory preset 的 LLM 跑归纳 loop）、`prompt-build`/`prompt-store`（三个 target 的归纳 prompt）、`self-talk-tool`（Memorize 私有思考工具 `self_talk`，不落盘）。Short Memory：`short-memory-store.ts`（主库 `alice.sqlite` 的 `short_memory_entries` 表：id/created_at/created_at_utc/content + 索引，统一 schema v10 幂等迁移，BEGIN IMMEDIATE 且每事务一次 insert，listLatest/listByCreatedAtUtcRange）、`short-memory-worker.ts`（`createShortMemoryWorker` 串行采集宿主 `~/.short_memory`：read→校验 `/[\p{L}\p{N}]/u`→事务 insert→原子 replace("\n")→commit，commit 失败补偿恢复原内容；`createHostShortMemoryFile` 按 `config.bashSandbox.hostWorkspaceDir` 映射容器路径并校验越界） |
| **llm-session** | LLM 会话管理。`sqlite-llm-session-store`（主库 `memory-files/llm-sessions.sqlite`：总表 `llm_session_meta` 六列 + 每 agent 类型 messages 分表三列）、`llm-session-pointer`（`current.json` 仅 `{sessionId, agentType}`，原子写）、`llm-session-runtime`（ensure/note/clear/delta transcript，单一内存所有者，SQLite 事务失败内存不变；`clearCurrentLLMSession` 异步，经统一清除协调器，`clearCurrentLLMSessionDirect` 供 Talk 回调内直接清除避免队列自等待）、浏览/列表/admin API、一次性迁移脚本 `scripts/migrate-llm-sessions-sqlite.ts`。`application/session-clear-coordinator.ts`：Chat/Talk/Memorize 三种会话清除统一串行协调入口（exists 执行时求值、Short Memory 采集成功后才清除、失败传播但队列继续，日志不记录正文） |
| **llm-gateway** | LLM 调用入口。`createOpenAICompatibleClient`（chat/completions + SSE + listModels）、`llm-requests.ts`（send + buildTools）、`llm-tool-loop.ts`（多轮 function-call loop，round/call 上限 100、continuation 恢复、全局 tool 注册表 `executeRegisteredLLMTool`）、运行时钩子（请求日志/usage/subagent transcript，SubAgent 转录落独立库 `memory-files/llm-subagent-sessions.sqlite`，失败降级不中断 LLM）、preset 配置（chat/talk 分离）；chat/talk 的延迟 response 会在格式化完成后通过同一 request 上下文提交，保留 usage 记录 |
| **agent-profile** | Prompt 层管理。`domain/prompt-layer.ts` 为**唯一公共 layer 解析入口**（normalize、layer→LLMMessage、tool 参数解析）；`build-system-prompt.ts`（PromptProfile + build/append messages + layer 内嵌 tool call 回填 + staticPromptFingerprint）；`shell.ts`（每日 persona/relationship/outfit，`createDailyShellStore`；选项级 `enabled` 开关，关闭的选项不参与随机选中） |
| **talk-session** | WebRTC 语音 talk 会话。SQLite 适配器（`logs/talk/talk.sqlite`，talk_sessions/events/transcript/outputs）、`createTalkRuntime`（open/append/delta/interrupt/claim；`closeSession` 异步，经统一清除协调器，成功后按序：重写 Talk LLM transcript → 标记 LLM session cleared 并清 pointer → 关闭 talk.sqlite 会话 → conversation-hub 投影 → 切 waiting，采集失败时保持打开）、`createTalkRuntimeRuntime`（+ conversation-hub 投影，会话关闭转 inbound 消息） |
| **conversation-hub** | 多渠道消息统一入口。`createMessageRuntime`（ingestEvent/ingestLifecycle/sendSystemNotice/processNow/flushAll）内部组装 agentLoopRuntime + heartbeat 全部任务；`canRunHeartbeat` 检查 Main Agent 占用（`isMainAgentBusy`），清除期间到达的消息只入库并标记 pending、不进入 loop，force_wake 先获取 clearing 占用再清除、成功后才唤醒；`sqlite-conversation-store` 为 Core 侧消息历史 |
| **capabilities** | 插件 admin 运行时（asr/photo/tts/geo/image-recognition 等 admin-plugin-*）+ `tool-output-target.ts`（AgentOutput 投递目标解析器，产出 AgentOutput 的工具必须经此解析） |
| **initiative** | Agent 主动行为。initiated-behavior 定义、触发评估、随机事件、admin 配置、JSON 存储 |
| **prompt-context** | Prompt 模板变量渲染运行时（user/时间/dailyShell/memory/calendar/skills/notes_list/outfit 变量树）。Short Memory 变量 `memory/shortMemory/content`：必填依赖 `shortMemoryStore`，取最新 wake boundary 的 `occurredAtUtc` 前 24 小时至当前的闭区间记录，输出 `<short_memories>` XML（`& < >` 转义，空结果固定空 XML），是否加入 Prompt layer 完全由用户 Prompt 编辑器配置决定 |
| **world-wanderer** | Google Street View 世界漫步空闲行为（移动 runtime、选路 policy、geo 计算） |
| **bash-sandbox** | Docker 沙箱 bash 执行（`createBashSandboxRuntime` + `createDockerBashExecutor`、命令权限分类）；`readSandboxNotesIndex` 同步读取容器内笔记目录索引（供 prompt 变量动态构建） |
| **pi-worker** | Pi worker 客户端（授权握手、后台唤起 wake、tool relay、健康轮询） |
| **approval** | 基于飞书动态卡片的一对一审批服务（含卡片动作回调鉴权） |
| **skills** | 技能注册表/加载器/占位符/资源路径 |
| **agent-run-indicator** | Agent run 指示器抽象（begin/setTyping/fail）+ 飞书动态卡片与 tool 执行上报适配器 |
| **persona / wardrobe** | 纯类型与工具函数（persona 快照；outfit 选择/查找） |

无独立 index.ts 的 context：agent-loop、agent-profile、talk-session、initiative、capabilities（跨 context 直接引用内部路径）。

### 4.3 channels —— 渠道插件

| 渠道 | 职责 |
|---|---|
| **feishu** | 基于 lark SDK 的 WSClient（WebSocket 订阅 5 类消息/生命周期事件 + 卡片 action）。消息归一化为 `AgentEvent`；动态卡片（agent run indicator / tool execution，30KB 上限，四元素 ID）；`/pair alice` 单联系人配对；DM/群聊策略（disabled/open/allowlist/requireMention）；typing 用 reaction 模拟；`createFeishuPlugin` 总装 |
| **wechat** | iLink `getupdates` 长轮询 + cursor 持久化；登录二维码扫码；图片走 CDN AES-128-ECB 加密上传，音频 ffmpeg+silk-wasm 转 SILK；出站仅 text/image/audio，需联系人 contextToken；状态 JSON 文件（`memory-files/indexes/wechat-ilink-state.json`） |
| **webrtc-voice** | 自研 WebSocket 信令（offer/ICE/speech-state/interrupt/hangup 等）；两个 peer 实现（werift 进程内 / fork 媒体处理子进程）；`createCallState` 通话状态机 + interrupt epoch + TTS producer 输出 pump + 播放队列；ffmpeg 转 Opus RTP 帧；浏览器测试页 |
| **tts** | 多 provider 路由（router）：转换 provider（OpenAI API/Bailian 百炼/Mimo）+ 本地服务（MOSS 8765 voice-clone、Genie 8767 stream 模式）；LLM 翻译后合成；流式合成与文本切块；preset 体系（core/shell/edit 四档）；纯符号输入返回静音 PCM |
| **asr** | 转写分发（tencent / multimodal_llm / openai_compatible）；ffmpeg 静音检测切分；伪流式会话（1.5s 长暂停 flush partial）；腾讯实时 WebSocket 流 |
| **image-generation** | 自拍图片生成（gateway 全局并发 2）：OpenAI `images/edits` 表单 / codex runner 两种模式；产物校验（扩展名白名单、路径防护、JPEG 归一化）。**无插件对象**，纯函数库 |
| **image-recognition** | 单文件纯函数：多模态 LLM 识别图片（base64 data URL 内联，不落盘），固定错误码集合。无插件对象 |
| **google-streetview** | 完整插件：坐标元数据/街景图（半径递增搜索）、pano graph、随机取点；pano 落盘复用；region/随机点/坐标 bucket 地理工具 |

### 4.4 capabilities/tools —— LLM 工具插件

全部为 `createXxxTools(deps): ToolPlugin` 工厂（契约 `id + listTools + execute` 定义在 `agent-loop/src/contracts/agent-contracts.ts`）。工具暴露给 LLM 由 **`toolNames`** 决定：chat-agent 先 `filterVisibleTools(allToolPlugins, promptProfile)` 按 prompt profile 过滤，再把可见工具名注入 LLM request。

| 工具 | Tool 名 | 职责 |
|---|---|---|
| messaging | `Chat` | 查看聊天记录 / 发送消息（text/markdown/image/voice/file）；`today` 从“睡眠茧时间点前 10 条消息”与最后一条 Short Memory 写入时间中的较晚起点开始，无睡眠茧时以今日锚点参与比较 |
| photo | `Selfie` | 自拍（pose 描述，生成前发进行中提示，禁止连续两次调用） |
| calendar | `calendar` | 日历增删查搜 + 上下文渲染（SQLite CalendarStore） |
| shell | `Bash` | 沙盒 bash 执行（透传 PiWorker） |
| file | `Read`/`Write`/`Edit`/`Glob` | 文件读写改查（图片转 llmFollowupAttachments） |
| location | Panorama | 街景与世界漫游：current 查看当前位置/teleport 传送重置轨迹/navigation 设导航目标 |
| restart | `restart` | 重启 Alice 服务（systemd） |
| subagent | `SubAgent` | 持久化 SubAgent 会话（spawn/send/wait/cancel/fork，走 PiWorker） |
| skills | `Skill` | 按名称加载技能（XML 输出） |
| dice | `Dice` | 投骰子 |
| sleep-cocoon | `sleep_cocoon` | 睡眠茧：in 钻进入睡（随机 ±15 分钟）/ out 取消 |
| bookcase | `Bookcase` | 书橱抽书讲故事 / 还书（assets/tools/bookcase/booksummaries.sqlite） |
| wardrobe | `Wardrobe` | 查看/切换服装（list/mirror/switch/random，可触发 on-body 生成） |
| finish-and-wait | `Yield` | 等待或结束：schedule（10s–15min 定时返回）/ await_chat（固定 15 分钟）/ finish；连续 schedule 且无 subagent 运行时拒绝（防空转） |


结构约束：
capabilities/tools/{tool name}/
├── src/                          # 业务代码
│   ├── index.ts                  # 导出 createXxxTools(deps): ToolPlugin 工厂（契约 id + listTools + execute）
│   └── *.ts                      # 复杂工具按需拆分（config.ts / types.ts / tool-runtime.ts 等）
├── profile.ts                    # 纯静态声明：ToolDefinition（name/description/inputSchema/suppressExecutionCard）
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

first-party skill 位于 `capabilities/skills/{name}/SKILL.md`（frontmatter 含 `name` / `description`），由 skills 注册表扫描（每次访问实时重扫），自动出现在 `{{system_skills}}`，经 `Skill` 工具按名称加载。现有内置技能：

| Skill | 职责 |
|---|---|
| list-installed-skills | 列出已安装的 third-party skills（`{{installed_skills}}` 动态构建） |
| list-notes | 列出 sandbox 中 `~/.agent/notes` 下的笔记（`{{notes_list}}` 加载时动态构建 name / description / path；笔记文件带同名 frontmatter，目录在 sandbox 容器内） |

### 4.5 platform 与 shared

- `platform/config`：环境变量解析（envBool/envNumber/envJsonObject）。
- `platform/time`：全局时间提供器（`createCurrentTimeProvider`），时区来自 `AGENT_TIMEZONE`（默认 Asia/Singapore），统一输出配置时区 wall-clock ISO。
- `platform/storage`：`calendar-store`（holiday/birthday/schedule）、`diary-store`（日记 + 睡眠边界）、`token-usage-store`、`sqlite-compat`（better-sqlite3 薄封装）、`admin-asset-utils`（资源路径安全校验）。
- `platform/scheduler`：`createDailyScheduler` 每日定时调度器。
- `platform/output-router`：按 `output.target.plugin` 注册/路由 `ChannelSender`。
- `shared/errors`（describeError）、`shared/admin-input`（管理后台输入校验）、`shared/clock`（CurrentTimeProvider 契约）、`shared/uuid`（createId）。

## 5. 核心运行时流程

### 5.1 聊天 loop（chat）

1. 渠道收到消息 → 归一化为 `AgentEvent` → 进入 conversation-hub `createMessageRuntime.ingestEvent`。
2. ChatAgent `prepareEventRun`：policy 检查（配对/allowlist/睡眠等）→ session 解析 → intent 路由 → prompt profile + `filterVisibleTools` 过滤 → 组装 LLM session。
3. `runLLMToolLoop`（llm-gateway）多轮 function-call loop：LLM request（toolNames 注入）→ tool call 经统一 `ToolPlugin.execute` 执行 → tool result 写回同一 loop → 直到产生 `AgentOutput`。
4. `AgentOutput` 经 `tool-output-target` 解析投递目标 → output-router → 渠道 send（飞书 renderer / 微信 / TTS 语音）。

### 5.2 心跳与主动行为（heartbeat）

`agent-heartbeat-runtime.runHeartbeatTasks` 依次处理：idle timer transition、randomized initiated behavior、timed yield（Yield 工具 schedule 到期）、talk session、sleep cocoon wake/goodnight、calendar reminder、pending session 队列。Agent 状态机 `AgentStateController`（idle/waiting/calling/away/sleeping 等）。

### 5.3 睡眠记忆归纳（Memorize）

睡眠窗口内对当天消息跑记忆归纳 loop：persistent（长期偏好）→ userPreferences → yesterdaySummary 三个 target，写入 `alice.sqlite` 的 long-term-memory / diary 表；`self_talk` 私有思考工具只记录不落盘。

## 6. 数据存储

| 数据 | 位置 |
|---|---|
| 长期记忆/日记/Core 侧消息历史/Short Memory | `memory-files/alice.sqlite`（long-term-memory / diary / persistent / userPreferences / `short_memory_entries`） |
| 追加式消息事件/调试日志 | `logs/message/message-logs.sqlite` |
| talk 语音会话 | `logs/talk/talk.sqlite` |
| LLM 会话（chat/talk/memorize） | `memory-files/llm-sessions.sqlite`（总表 + agent messages 分表） |
| SubAgent 会话 | `memory-files/llm-subagent-sessions.sqlite` |
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
- API 覆盖：prompt/shell 管理、memory（含 run-day/undo/redo、Short Memory 只读区块最新 100 条）、LLM 会话浏览（llm-chain）、token usage、logs、插件配置（`/admin/api/plugins`，9 个插件条目）、渠道（飞书/微信 start/stop/pairings/二维码）、agent state、TTS/ASR/photo/geo 配置（持久化到 .env）。
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
