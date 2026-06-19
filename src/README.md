# src 模块职责说明

本文档按模块解释 `src/` 下代码的职责边界。目标不是列文件名，而是说明每个模块为什么存在、负责什么、不负责什么，以及内部关键文件的分工。

## 总体分层

`apps/` 是进程入口和装配层，只负责把系统启动起来。

`contexts/` 是业务核心，每个目录是一个业务边界。

`channels/` 是外部通道适配器，只处理第三方协议、格式转换和发送接收。

`capabilities/` 是 LLM 可调用能力，包括 tools 和 skills。

`platform/` 是技术基础设施，不表达 Alice 业务语义。

`shared/` 是无业务语义的共享类型和小工具。

---

# apps

## `apps/api/`

职责：单进程 API 应用，托管 HTTP server、管理后台、voice-call 页面，并作为 composition root 把 contexts、channels、capabilities、platform 接起来。

不负责：业务规则、LLM request 拼装、memory 归纳策略、conversation merge、agent loop 状态机。

关键模块：

- `main.ts`: 进程入口，只调用 API runtime 启动。
- `bootstrap/api-root-runtime.ts`: 顶层 composition root，创建 foundation、LLM runtime、control runtime、tooling runtime、agent runtime、server runtime。
- `bootstrap/api-foundation-runtime.ts`: 基础设施装配，包括 time、config、logging、storage。
- `bootstrap/api-bootstrap-runtime.ts`: dotenv、配置、LLM preset store、进程单例锁和基础 LLM client。
- `bootstrap/api-runtime-state.ts`: API 进程内 mutable 状态，例如 active LLM session、近期 request/response logs。
- `bootstrap/api-agent-runtime.ts`: 把 app 层依赖注入 agent-loop 和 talk-session runtime。
- `bootstrap/api-agent-stack-runtime.ts`: 聚合 chat core、talk loop、talk runtime。
- `bootstrap/api-capabilities-runtime.ts`: 装配 tools、TTS/ASR channel、prompt preview service、LLM request runtime。
- `bootstrap/api-communication-runtime.ts`: 装配 Feishu、WeChat、WebRTC voice 等通信 channel。
- `bootstrap/api-context-runtime.ts`: 装配 profile、memory、initiative、channel state stores。
- `bootstrap/api-control-runtime.ts`: 装配控制面、主动行为、系统通知。
- `bootstrap/api-llm-runtime.ts`: 装配 LLM session archive、active session runtime、observability。
- `bootstrap/api-log-runtime.ts`: 进程内日志缓存和日志 store hydration。
- `bootstrap/api-notice-runtime.ts`: 装配 conversation-hub 的 outbound notice runtime。
- `bootstrap/api-startup-runtime.ts`: 启动后启动 channel、注册调度器、执行初始化。
- `bootstrap/api-support-runtime.ts`: 装配 admin LLM session 和 sleep-memory bridge。
- `bootstrap/api-tooling-runtime.ts`: 聚合 capabilities runtime 和 support runtime。
- `bootstrap/app-config-runtime.ts`: API app 配置结构和 env 解析。
- `bootstrap/channel-plugin-runtime.ts`: Feishu/WeChat channel plugin factory wiring。
- `bootstrap/channel-state-runtime.ts`: channel 本地状态文件 store wiring。
- `bootstrap/default-target-runtime.ts`: 默认消息目标解析 wiring。
- `bootstrap/message-runtime-runtime.ts`: message heartbeat/runtime wiring。
- `bootstrap/voice-plugin-runtime.ts`: TTS channel 与 llm-gateway 的 app 层适配。
- `bootstrap/web-rtc-voice-runtime.ts`: WebRTC voice 与 TalkRuntime/ASR/TTS 的 app 层适配。
- `routes/admin-routes.ts`: 管理后台 route 分派。只解析 HTTP request、调用 context/capability/channel service、写 response。
- `apps/api/bootstrap/admin-context-runtime.ts`: 将 API runtime dependencies 组装为 admin route context。
- `apps/api/bootstrap/api-admin-runtime.ts`: 管理后台 request handler wiring。
- `apps/api/admin-ui/admin-html.ts`: 管理后台前端 HTML/CSS/JS。
- `routes/voice-call-routes.ts`: voice-call HTTP/WebSocket route glue。
- `routes/voice-call-contract.ts`: voice-call API DTO。
- `routes/voice-call-html.ts`: voice-call 浏览器页面。
- `platform/storage/src/admin-asset-utils.ts`: admin asset path 校验。
- `middleware/http-utils.ts`: HTTP body、JSON、loopback 管理请求校验。
- `server/api-server-runtime.ts`: HTTP server 创建和请求分派。
- `server/api-server-stack-runtime.ts`: server stack wiring。
- `server/api-lifecycle-runtime.ts`: shutdown 和生命周期编排。
- `server/api-https.ts`: HTTPS server helper。
- `server/http-shutdown.ts`: keepalive socket shutdown helper。
- `server/singleton-lock.ts`: API 进程单例锁。
- `server/env-file.ts`: `.env` 更新 helper。

---

# contexts

## `contexts/agent-loop/`

职责：拥有 AgentCore、chat/talk LLM loop、agent 状态机、tool-call 流程与 session 模式切换。

不负责：HTTP、具体 channel SDK、长期记忆写入策略、LLM provider client。

关键模块：

- `application/agent-core.ts`: AgentCore facade。接收 AgentEvent，解析 intent，运行 chat loop，处理 LLM session、固定前缀、token pressure、主动行为事件。
- `application/run-chat-loop.ts`: Chat loop 的核心执行器。负责 prompt 构建、tool-call round、wait_chat yield、streaming send_chat 处理、tool result 追加。
- `application/run-talk-loop.ts`: Talk loop 执行器。面向实时对话 session，和 chat loop 分离 agent id 与消息构造。
- `application/intent-router.ts`: 默认 intent router。把文本事件分成 chat、codex 或 unsupported。
- `application/session-resolver.ts`: 默认 session id 解析。根据 plugin、scope、thread/channel/user/raw message 生成 session key。
- `application/prompts.ts`: agent-loop 侧 prompt 兼容桥接。
- `domain/agent-loop-state.ts`: agent 行为状态机，包括 idle、waiting、sleeping、going_to_sleep 等状态和 transition 数据。
- `ports/policy.ts`: policy port。当前提供 allow-all 默认实现。
- `contracts/agent-contracts.ts`: AgentEvent、AgentOutput、ChannelPlugin、ToolPlugin、ToolDefinition 等跨模块 contract。
- `runtime/agent-core-runtime.ts`: 将 app 层 stores、LLM runtime、output router、tools 注入 AgentCore。
- `runtime/agent-state-runtime.ts`: agent state runtime 和状态持久化 wiring。
- `runtime/agent-loop-runtime.ts`: 主 LLM loop runtime，规划中用于统一 chat/talk loop 调度、运行状态和中断。
- `runtime/agent-heartbeat-runtime.ts`: heartbeat timer/pause/resume runtime，驱动 chat/talk 下一轮调度。

## `contexts/agent-profile/`

职责：拥有 persona/profile/prompt/shell 的数据模型、解析、存储和预览。

不负责：实际调用 LLM、执行 agent loop、发送 channel 消息。

关键模块：

- `prompts/prompt-profile.json`: Chat prompt profile。
- `prompts/talk-prompt-profile.json`: Talk prompt profile。
- `prompts/prompt-api-profile.json`: Chat/Talk/Memorize 到 LLM API preset 的绑定。
- `prompts/memorize-prompts.json`: Memorize prompt profile。
- `prompts/memory-induction-prompts.json`: Memory induction prompt layers。
- `prompts/shell-prompt-template.txt`: Shell prompt 模板。
- `domain/prompt-layer.ts`: prompt layer parser 和类型。所有 prompt layer 解析必须走这里。
- `domain/shell.ts`: shell、outfit、daily shell 的领域类型和 store contract。
- `application/build-system-prompt.ts`: PromptProfile normalization、visible tools 判断、LLM messages 构建。
- `application/llm-text-renderer.ts`: `{{variable}}` 渲染、LLMTextVariables 构建、tool result 文本化。
- `application/prompt-tool-preview-runtime.ts`: prompt preview 和 tool preview 应用服务。负责构造 preview context、渲染 visible tool specs、保护 preview 中的 send_chat。
- `adapters/json-prompt-profile-store.ts`: prompt/profile JSON 存储路径和读写 adapter。
- `adapters/json-core-profile-store.ts`: core profile JSON store，例如 appearanceDescription。
- `ports/prompt-rendering.ts`: prompt rendering 端口。
- `ports/shell-store.ts`: shell store 端口。

## `contexts/conversation-hub/`

职责：拥有 conversation/message/log 的统一入口，管理消息持久化、消息接入、系统通知落库和发送记录。

不负责：agent loop 该怎么回复、LLM 怎么调用、channel SDK 细节。

关键模块：

- `application/ingest-channel-message.ts`: channel inbound/lifecycle event 接入 conversation store，并触发 dirty session。
- `application/bootstrap-storage.ts`: 创建 conversation store、token usage store、system log store 的 storage wiring。
- `application/outbound-notice-runtime.ts`: 系统通知和 memory failure notice 的发送用例。负责创建 AgentOutput、写 outbound message、标记 sent/failed、写 message log。
- `application/session-dirty-flagger.ts`: session dirty debounce/flush。用于把多条入站消息合并触发处理。
- `adapters/sqlite-conversation-store.ts`: SQLite conversation/message/message_logs store。
- `adapters/file-log-store.ts`: JSONL file log store。
- `ports/conversation-store.ts`: conversation store port。
- `src/index.ts`: context public exports。

## `contexts/initiative/`

职责：拥有主动行为的定义、配置、prompt profile、触发和运行记录。

不负责：agent loop 具体执行细节、HTTP 表单、channel 发送。

关键模块：

- `behaviors/*.json`: 每个主动行为的 prompt profile，例如 `sleep_goodnight`、`care`、`review`。
- `behaviors/initiated-behaviors.config.json`: 行为开关、kind、triggerEvent、weight、priority 覆盖配置。
- `domain/initiated-behavior.ts`: 主动行为领域模型、默认 plans、availability 判断、run store。
- `adapters/json-initiated-behavior-store.ts`: 行为配置和 prompt profile JSON 读写。
- `application/evaluate-triggers.ts`: 读取配置、合并 overrides、修改行为配置。
- `application/api-initiated-behavior.ts`: API/control runtime 用的主动行为 wiring，包括 sleep cocoon 相关触发。

## `contexts/llm-gateway/`

职责：拥有 LLM API preset、provider client、LLM request shape、tool spec 构建、tool loop、请求日志、token usage 和 request preview。

不负责：chat/talk session 状态、prompt profile 存储、具体 tool 实现、channel 发送。

关键模块：

- `index.ts`: LLM gateway public API，包含 OpenAI compatible client。
- `llm-api-profile.ts`: LLM API preset store、preset 解析、client factory。
- `llm-config-runtime.ts`: 当前 chat/talk LLM config resolver。
- `llm-requests.ts`: 根据 ToolPlugin 和变量构造 LLM tool specs。
- `llm-requests-runtime.ts`: LLM request sender，负责取消、重试、日志、stream 开关。
- `llm-tool-loop.ts`: LLM tool-call loop executor。
- `llm-request-shape.ts`: LLM request DTO/shape helper。
- `llm-request-diff.ts`: request diff 和变更展示。
- `llm-request-preview-runtime.ts`: 管理后台 LLM request preview。
- `llm-log-runtime.ts`: request/response log runtime。
- `llm-observability-runtime.ts`: token usage、usage log、observability wiring。
- `token-usage-runtime.ts`: token usage report。
- `token-pricing.ts`: model pricing helper。

## `contexts/llm-session/`

职责：拥有 LLM session 指针、归档文件、active session 恢复、session list/detail view。

不负责：memory LLM session 的归纳逻辑、LLM provider client、tool execution。

关键模块：

- `adapters/jsonl-llm-session-log.ts`: JSONL session archive adapter。负责 session 文件路径、metadata、messages 读写和 clone。
- `domain/llm-session.ts`: LLM session domain types。
- `domain/llm-session-utils.ts`: metadata 中 request/response/round 的解析 helper。
- `application/active-llm-session.ts`: active session pointer、transcript 更新、talk/chat active session 判断。
- `application/archive-llm-session.ts`: session archive root、文件收集、相对路径、安全路径解析。
- `application/create-llm-session.ts`: API session runtime，负责恢复 active session、创建 chat/talk session。
- `application/list-llm-sessions.ts`: session 列表聚合。
- `application/llm-session-view.ts`: session detail、turns、jsonl entries 构造。
- `application/admin-llm-session.ts`: 管理后台会话聚合入口，组合 active/list/view/preview/memory console。
- `src/index.ts`: context public exports。

## `contexts/memory/`

职责：拥有长期记忆、记忆文件/SQLite store、记忆归纳、sleep window、Memory prompt preview、memorize LLM session 管理。

不负责：HTTP route、Chat AgentCore、channel 发送。

关键模块：

- `memory.ts`: memory context 主要实现。包括 MemoryStore、MemoryInductionPromptStore、sleep window 解析、prompt preview、runMemoryInductionForMessages。
- `index.ts`: memory public API 和部分实现入口。
- `contracts/memory-config.ts`: MemorySummaryConfig contract。
- `application/admin-memory-runtime.ts`: 管理后台 memory 用例。负责手动 run-day/run-target、prompt preview、memory file 保存、SQL 最新记录删除、git undo/redo、run progress。
- `application/induce-memory.ts`: memory induction 用例入口。
- `application/manage-memory-console.ts`: memory console session 管理入口。
- `application/manage-memory-llm-session.ts`: memorize LLM session list/detail。
- `application/profile-memory.ts`: profile、memory、diary、shell stores bootstrap。
- `application/sleep-memory-bridge.ts`: sleep boundary 到 memory induction 的 bridge 入口。
- `memory-console-runtime.ts`: memory console runtime 实现。
- `profile-memory-runtime.ts`: profile/memory runtime 实现。
- `sleep-memory-bridge-runtime.ts`: sleep memory bridge 实现。
- `sleep-memory-induction-runtime.ts`: sleep memory induction 实现。

## `contexts/talk-session/`

职责：实时对话 session、assistant output chunk、interrupt、breakpoint context、talk storage。

不负责：WebRTC signaling、ASR/TTS provider、LLM provider client。

关键模块：

- `adapters/sqlite-talk-session-store.ts`: talk session SQLite store。保存 talk_sessions、talk_events、talk_segments 等。
- `application/talk-session-runtime.ts`: TalkRuntime 应用服务。负责 open/close session、ingest input、claim ready output chunk、mark played、interrupt output、构造下一轮 LLM messages。
- `runtime/talk-session-runtime.ts`: 将 TalkRuntime 和 talk agent loop 组装给 app 层使用。

---

# channels

## `channels/asr/`

职责：ASR provider adapter。把音频输入转成 transcript/result，隐藏 provider 差异。

关键模块：

- `src/index.ts`: ASR config、transcriber、provider session、admin test helper。

## `channels/feishu/`

职责：Feishu/Lark channel adapter。负责 Feishu WebSocket、事件规范化、绑定策略、生命周期事件、出站渲染和发送。

关键模块：

- `src/index.ts`: Feishu ChannelPlugin factory。
- `src/client.ts`: Feishu SDK client 和 WebSocket 订阅。
- `src/monitor.ts`: lifecycle facade。
- `src/handlers/message.ts`: 文本消息转 AgentEvent。
- `src/handlers/lifecycle.ts`: reaction/read/recall 转 lifecycle event。
- `src/renderer.ts`: AgentOutput 转 Feishu send plan。
- `src/pairing.ts`: 唯一联系人绑定。
- `src/policy.ts`: DM/group policy。
- `src/bindings.ts`: session binding。
- `src/dedupe.ts`: event dedupe。
- `src/outbound.ts`: outbound test helper。
- `src/config.ts`: config helper。
- `src/types.ts`: Feishu local types。

## `channels/tts/`

职责：TTS channel。负责 translation-before-TTS、Genie/MOSS synthesis、streaming audio chunk、voice model preset。

关键模块：

- `src/index.ts`: TTS config、translation、streaming synthesis、remote/local Genie/MOSS synthesizer。

## `channels/webrtc-voice/`

职责：Browser voice-call channel。负责 WebRTC signaling、server outbound audio track、ASR inbound audio stream、TTS playback queue、barge-in/interrupt 的 channel 侧处理。

关键模块：

- `src/index.ts`: WebRTC voice plugin、signaling server、RTP/PCM/Opus helpers、playback queue。

## `channels/wechat/`

职责：WeChat iLink channel adapter。负责 iLink client、login、contacts、inbound/outbound message mapping。

关键模块：

- `src/client.ts`: iLink HTTP/long-poll client。
- `src/index.ts`: WeChat ChannelPlugin factory。
- `src/state.ts`: credentials/contact state store。
- `src/types.ts`: WeChat local types。

---

# capabilities

## `capabilities/tools/messaging/`

职责：LLM chat 工具能力。提供 check_chat、send_chat、wait_chat/search 等 messaging tools。

关键模块：

- `src/index.ts`: tool definitions、execute、formatCheckChatMessages、send flow。
- `src/tool-runtime.ts`: messaging runtime wiring。
- `src/sent-message-utils.ts`: channel send result 中 message id/time 提取。

## `capabilities/tools/photo/`

职责：自拍/photo tool。生成图片 prompt、调用 selfie executor、发送生成图片。

关键模块：

- `src/index.ts`: photo tool plugin 壳和 tool name 分发。
- `src/selfie-tool.ts`: `selfieTool` 定义、selfie 执行流程、目标解析、prompt 模板渲染、引用图收集。
- `src/config.ts`: photo config、admin public config、模式到 Image API 设置的选择。
- `src/send-output.ts`: outbound 存储、发送、消息日志。
- `src/openai-api-selfie.ts`: `openai` / `openaiRelay` executor。
- `src/codex-selfie.ts`: `codex` executor。
- `src/image-files.ts`: 生成图校验、JPEG 归一化、mime 检测。
- `src/process-exec.ts`: 子进程执行 helper，供 codex executor 和图像转换复用。

## `capabilities/tools/shell/`

职责：shell/outfit 管理 tool，让 LLM 查询和切换当前外观/状态。

关键模块：

- `src/index.ts`: shell tools。

## `capabilities/tools/bookcase/`

职责：讲故事书橱 tool。抽书、归还书，并触发 AgentCore fixed-prefix mode。

关键模块：

- `src/index.ts`: bookcase draw/return tool。

## `capabilities/tools/sleep-cocoon/`

职责：睡眠 cocoon 相关 tool 和事件。控制入睡、醒来、force wake 等交互能力。

关键模块：

- `src/index.ts`: sleep cocoon tools。
- `src/sleep-cocoon-event-runtime.ts`: sleep cocoon event runtime。
- `src/sleep-cocoon-math.ts`: 睡眠时间/概率计算。

## `capabilities/tools/workspace-files/`

职责：workspace 文件工具。提供 Read/Edit/Glob/Grep 给记忆归纳和 workspace 操作。

关键模块：

- `src/index.ts`: workspace file tools 实现。

## `capabilities/skills/`

职责：skill 定义目录。当前只有 selfie external skill 已实际使用，其余目录是未来 skill 分类说明。

关键模块：

- `external/alice-selfie-fast/SKILL.md`: selfie fast skill metadata。
- `external/alice-selfie-fast/scripts/run-alice-selfie-fast.mjs`: selfie fast runner。
- `external/alice-selfie-fast/agents/openai.yaml`: selfie runner agent config。

---

# platform

## `platform/config/`

职责：通用 env/config parsing helper，不包含 Alice 业务配置 schema。

关键模块：

- `src/index.ts`: envBool、envNumber、envJsonObject、trimTrailingSlashes。
- `src/globals.d.ts`: global type declarations。
- `src/node-http.d.ts`: Node HTTP type declarations。

## `platform/event-bus/`

职责：技术层 pub/sub。当前不是主事件链路，只提供 in-memory event bus。

关键模块：

- `src/index.ts`: createInMemoryEventBus。

## `platform/output-router/`

职责：把 AgentOutput 路由到注册的 ChannelPlugin。

关键模块：

- `src/index.ts`: OutputRouter interface 和 createOutputRouter。

## `platform/scheduler/`

职责：进程内调度器和每日维护任务。

关键模块：

- `src/index.ts`: createDailyScheduler、delayUntilNext、createDailyMaintenanceTasks、cleanupPreviousTtsFiles。

## `platform/storage/`

职责：底层 storage helper。这里是技术存储能力，不拥有业务用例。

关键模块：

- `src/diary-store.ts`: diary/sleep boundary SQLite store。
- `src/sqlite-compat.ts`: sqlite/better-sqlite3 compatibility loader。
- `src/token-usage-store.ts`: token usage SQLite store。

## `platform/text-renderer/`

职责：通用 text rendering helper。

关键模块：

- `src/index.ts`: text renderer。

## `platform/time/`

职责：timezone-aware current time provider 和时间格式 helper。

关键模块：

- `src/index.ts`: mutable/current time provider、format/parse zoned time。

---

# shared

## `shared/clock/`

职责：跨层共享 CurrentTimeProvider 类型，不依赖业务模块。

关键模块：

- `src/index.ts`: CurrentTimeProvider type。

## `shared/uuid/`

职责：跨层 ID 生成 helper。

关键模块：

- `src/index.ts`: createId。
