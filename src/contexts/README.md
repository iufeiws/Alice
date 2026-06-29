# contexts

`contexts/` 是系统核心业务边界。每个 context 表达一个业务概念，内部按职责使用：

- `domain/`: 领域模型、纯规则、类型。
- `application/`: 用例和应用服务。
- `ports/`: 外部依赖端口。
- `adapters/`: 持久化/第三方/文件等适配。
- `runtime/`: runtime composition 或生命周期。
- `contracts/`: 对外 DTO、事件协议。

当前 context：

- `agent-loop/`: chat/talk agent loop 与 ChatAgent。
- `agent-profile/`: prompt/profile/shell/persona。
- `conversation-hub/`: conversation/message/log 归一化和存储入口。
- `initiative/`: 主动行为配置、触发和运行记录。
- `llm-gateway/`: LLM request、client、tool-loop、观测。
- `llm-session/`: LLM session 指针、归档、列表和视图。
- `memory/`: 长期记忆、记忆归纳、sleep window。
- `talk-session/`: 实时对话 session、chunk、interrupt。

## Agent loop runtime refactor plan

目标：把 chat/talk 的下一轮发起、主 LLM session 状态、运行中断和 heartbeat 调度收敛到 `agent-loop`，避免 message runtime、talk runtime、ChatAgent 各自启动 loop 导致 session 边界泄漏。

### 设计原则

- `activeMainLLMSession` 是 agent loop 运行态的全局唯一主 LLM session boundary；除它之外，任何 LLM session 内容都只从 `llm-session` 的 `archive/current` JSONL 指针读取和写入。
- chat/talk 可以切换 current session 文件，但切换和 request/response 写回都必须通过 `llm-session` current pointer 完成，不在 API runtime 或 agent loop runtime 另存 session 对象。
- `messagingTools` 不再自行推断 LLM session 边界；它应从 `agent-loop-runtime` 暴露的主 session 状态读取当前 loop/session 信息。
- 所有下一轮发起收敛到 heartbeat。message runtime 和 talk runtime 只记录输入、状态和 ready/dirty 标记，不直接启动 LLM loop。
- LLM request 运行时 heartbeat 暂停或跳过调度；请求完成后由 runtime 恢复调度。

### 目标文件职责

- `agent-loop/src/runtime/agent-state-runtime.ts`
  - 原 `agent-loop-runtime.ts` 改名而来。
  - 只负责 agent state controller wiring 和 sleeping/woke 状态副作用。
- `agent-loop/src/runtime/agent-loop-runtime.ts`
  - 新建主 loop runtime。
  - 维护 `activeMainLLMSession`、当前 running 状态、取消控制、loop kind、session boundary。
  - 通过 `requestRun(kind)` 统一启动 chat/talk prepared loop run spec，并向 tools 暴露主 session 状态。
  - 在 `requestRun(kind)` 内部调用 `llm-tool-loop`，不再暴露第二条 runtime 直跑入口。
- `agent-loop/src/runtime/agent-heartbeat-runtime.ts`
  - 从 message runtime 拆出的独立 heartbeat。
  - 负责 tick agent state、扫描 pending inbound、触发 initiated behavior/sleep events、calling 状态下驱动 talk loop。
- `agent-loop/src/application/run-chat-loop.ts`
  - 构建 chat function-call loop 启动参数、streaming send adapter 和完成写回 adapter。
- `agent-loop/src/application/run-talk-loop.ts`
  - 构建 talk function-call loop 启动参数、runtime transcript patch、stream output adapter 和完成写回 adapter。
- `agent-loop/src/application/agent-loop-tool-executor.ts`
  - 统一 `toolName -> plugin`、JSON args、`plugin.execute`、error result 和 LLM tool message formatting；chat/talk 只保留各自的 adapter hook。
- `agent-loop/src/application/agent-function-call-loop.ts`
  - 统一 function-call loop spec 构筑入口和默认 loop limits；chat/talk adapter 只提供各自 request、tool、stream、writeback 回调。
- `agent-loop/src/application/chat-loop-tool-control.ts`
  - 将 chat tool result 到 loop control / session rebuild mode 的转换从 `run-chat-loop.ts` 移出，降低 chat loop adapter 内部业务分支。
- `agent-loop/src/application/chat-loop-request-sender.ts`
  - 将 chat 本地 LLM request sender、tool schema rendering、retry/backoff 和 LLM lifecycle logging 从 `run-chat-loop.ts` 移出。
- `agent-loop/src/application/chat-loop-session-context.ts`
  - 将 chat fixed-prefix append、finish_and_wait resume、check_chat cursor、token estimate 和 session-context helpers 从 `run-chat-loop.ts` 移出。
- `agent-loop/src/application/talk-loop-session-context.ts`
  - 将 talk prompt context、prompt variables、prompt tool execution 和 active transcript patch preparation 从 `run-talk-loop.ts` 移出。
- `agent-loop/src/runtime/agent-loop-session-initializer.ts`
  - 统一 chat/talk session 初始化、prefix/runtime patch append 和 transcript writeback helper。

### 迁移步骤

1. [done] 将 `agent-loop/src/runtime/agent-loop-runtime.ts` 改名为 `agent-state-runtime.ts`，更新 import/export，保持行为不变。
2. [done] 新建 `agent-loop/src/runtime/agent-loop-runtime.ts`，维护全局 `activeMainLLMSession`、running 状态和 interrupt，并通过注册的 chat/talk runner 统一发起 loop run。
3. [done] 引入 `activeMainLLMSession` 命名和主 session 状态 port；`messagingTools` 默认 `check_chat` scope 已从该 port 获取 session boundary，不再依赖工具内部计数猜测。
4. [done] 将 message runtime 中 heartbeat timer/pause/resume、tick、pending 扫描和 generated/talk 触发编排迁移到 `agent-heartbeat-runtime.ts`；message runtime 保留 ingest、store、pending set 和具体任务回调。
5. [done] 普通 inbound、manual process、finish_and_wait resume、initiated behavior、sleep cocoon events 的 loop 发起统一经 heartbeat/task 路径调用 `agent-loop-runtime.requestRun(...)`。
6. [done] talk runtime 外层自旋已改为 ready/claim 模式，内层 backpressure 已接入真实待播输出量；播放后的下一轮通过 ready 标记交回 heartbeat，function-call/tool-result follow-up 在同一次通用 run loop 内完成，不再交给 heartbeat。
7. [done] 从 `run-chat-loop.ts` 抽出通用 loop execution spec；生产 chat runtime 先构建 prepared spec，再由 `agent-loop-runtime.requestRun(...)` 内部统一执行。
8. [done] 将 `run-talk-loop.ts` 改为 talk loop spec 构建器；生产 talk runtime 先构建 prepared spec，再由 `agent-loop-runtime.requestRun(...)` 内部统一执行。talk 首轮构筑 current transcript prefix，后续由 `talkRuntime.buildNextLoopMessagePatch(...)` 返回 `{ replaceFrom, messages }` 替换 prefix 后的 runtime transcript 尾部。
9. [done] `agent-loop-runtime.requestRun(kind)` 已只接受 `prepareChat/prepareTalk` prepared run，并统一执行 prepared spec；API 生产 chat/talk wiring 和 `conversation-hub` fallback 均不再注册 legacy `runChat/runTalk` runner，message runtime 的 chat agent 依赖也已收紧为 `prepareEventRun(...)`。`ChatAgent` 已不再暴露 direct `handleEvent(...)` 执行入口，只构建 prepared run；`run-chat-loop.ts` 已只导出 `buildChatAgentLoop(...)` spec 构建器，`run-talk-loop.ts` 已只导出 talk prepared run 构建入口，不再导出 direct run 方法；talk runtime 的外部入口已改为 `markAgentLoopReady(...)`、`claimReadyAgentLoopSession(...)`、`prepareReadyAgentLoopSession(...)`，只表达 ready/claim/prepare，不再暴露 `startAgentLoop` 命名；旧 `SessionDirtyFlagger` 独立延迟调度残留已删除。prepared run 支持 lazy `prepare()`；agent loop runtime 不再持有 session object，chat/talk transcript 的 load/update/clear 均通过 `llm-session` current JSONL 指针完成；LLM observability request/response 写回也通过同一 `llmSessionRuntime` port 完成。`run-talk-loop.ts` 保留 prompt/tool/voice IO adapter。
10. [done] 删除旧兼容层和历史配置/接口残留，更新测试与文档；`processNow` 的 manual fallback 也已通过 heartbeat forced run task 发起，不再由 message runtime 直接 fallback 启动 loop。
11. [done] 抽出 `AgentLoopToolExecutor`，chat/talk 普通 LLM tool call、prompt tool call 统一走公共 `toolPlugins` lookup/execute/error/format 路径；chat 的 streaming send 仍作为流式输出 adapter hook 保留。
12. [done] 抽出 `AgentLoopSessionInitializer`，`agent-loop-runtime` 通过公共 helper 处理 loop-local session context create/set/clear、chat prompt session prepare/ensure、talk prefix 初始化和 runtime transcript patch append/writeback。
13. [done] 抽出 `AgentFunctionCallLoopSpec` 构筑 helper，chat/talk 不再各自直接拼默认 function-call loop limits，统一经公共 builder 生成 `llm-tool-loop` spec。
14. [done] 删除 prompt tool request 对 `send_chat` 的 loop 层特殊拦截；已配置/暴露的 prompt tool call 统一走 `toolPlugins` 执行，禁用能力由配置层不暴露或不配置处理。
15. [done] 将 prompt tool request helper 移入 `AgentLoopToolExecutor`，`run-chat-loop` 只保留兼容 re-export 和 adapter 调用，不再拥有 prompt tool 执行实现。
16. [done] 将 chat 每分钟 LLM request timestamp 窗口维护抽入 `AgentLoopSessionInitializer.claimAgentLoopRequestWindow(...)`，`run-chat-loop` 不再手写 requestTimestamps 过滤和追加。
17. [done] 抽出 `chat-loop-tool-control.ts`，`run-chat-loop` 不再直接展开 tool result reset/fixed-prefix mode 构筑逻辑，而是执行 tool 后调用 helper 生成 loop control 和待应用 mode state。
18. [done] 抽出 `talk-loop-session-context.ts`，`run-talk-loop` 不再直接构建 talk prompt context、prompt variables、prompt tool runner 和 current transcript patch，只消费 prepared session context。
19. [done] 抽出 `chat-loop-request-sender.ts`，`run-chat-loop` 不再拥有本地 LLM request sender、tool schema rendering、retry/backoff 和 lifecycle logging 实现。
20. [done] 抽出 `chat-loop-session-context.ts`，`run-chat-loop` 不再拥有 fixed-prefix append、finish_and_wait resume、check_chat cursor、token estimate 和 session-context helper 实现，仅保留兼容 re-export。

### 当前已知风险

- `finish_and_wait` resume 依赖主 session 中未完成 tool call，后续迁移 llm-session 存储层 pointer 时必须保留 pending tool result 拼接语义。
- talk 对延迟敏感；calling 状态下 heartbeat 可能需要短 tick 或事件唤醒，而非固定 1 秒。
- `messagingTools` 的默认 `check_chat` scope 必须由主 loop/session 状态明确决定，不能再由工具私有计数跨 agent 边界推断。
- `activeMainLLMSession` 是唯一运行态 session 指针；`llm-session` 的 `archive/current` JSONL 是会话内容事实源。

## Capability tool output target refactor

目标：LLM session 构筑仍通过统一 `toolNames` 暴露工具；工具能否使用不由 `requester/channel` 决定。`requester` 只描述本次 tool call 来源，产生 `AgentOutput` 的工具通过 capabilities 层统一解析投递目标。

### 当前状态

1. [done] `llm-gateway`/`ChatAgent` 的 `toolNames -> getTool -> buildTools` 注册链路保持不变；chat/talk 不减少 tool call 暴露。
2. [done] 新增 `capabilities/src/tool-output-target.ts`，提供统一 `ToolOutputTargetResolver`。
3. [done] `messaging/photo/shell/bookcase/sleep-cocoon` 工具运行时接入统一 resolver。
4. [done] `webrtc_voice` 这类非消息 requester 不再被当作图片/文本投递 channel；工具输出回落到当前默认消息目标。
5. [done] 新增覆盖：voice call requester 触发 `selfie` 时，开始通知和图片输出都投递到默认消息目标。

### 约束

- 不通过隐藏 talk tool、减少 toolNames 或按 channel 裁剪工具来规避问题。
- 具体工具仍可以定义自己的固定输出语义，但公共投递目标解析必须走 capabilities 层接口。
- 后续如果新增非消息 requester，应扩展 resolver 配置，而不是在单个 tool 内硬编码 channel fallback。
