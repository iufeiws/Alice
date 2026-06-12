# contexts

`contexts/` 是系统核心业务边界。每个 context 表达一个业务概念，内部按职责使用：

- `domain/`: 领域模型、纯规则、类型。
- `application/`: 用例和应用服务。
- `ports/`: 外部依赖端口。
- `adapters/`: 持久化/第三方/文件等适配。
- `runtime/`: runtime composition 或生命周期。
- `contracts/`: 对外 DTO、事件协议。

当前 context：

- `agent-loop/`: chat/talk agent loop 与 AgentCore。
- `agent-profile/`: prompt/profile/shell/persona。
- `conversation-hub/`: conversation/message/log 归一化和存储入口。
- `initiative/`: 主动行为配置、触发和运行记录。
- `llm-gateway/`: LLM request、client、tool-loop、观测。
- `llm-session/`: LLM session 指针、归档、列表和视图。
- `memory/`: 长期记忆、记忆归纳、sleep window。
- `talk-session/`: 实时对话 session、chunk、interrupt。

## Agent loop runtime refactor plan

目标：把 chat/talk 的下一轮发起、主 LLM session 状态、运行中断和 heartbeat 调度收敛到 `agent-loop`，避免 message runtime、talk runtime、AgentCore 各自启动 loop 导致 session 边界泄漏。

### 设计原则

- `activeMainLLMSession` 是 agent loop 运行态的全局唯一主 LLM session boundary，chat/talk 都通过它暴露当前 loop/session 状态。
- 当前阶段保留 `ensureActiveLLMSession(agentId)` 遇到不同 `agentId` 时切 session 的行为，因为 chat/talk static prefix 不兼容；因此 llm-session 存储层的 `archive/current` pointer 尚未彻底统一成 chat/talk 混用同一条主 session。
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
  - 统一启动 chat/talk loop run spec，并向 tools 暴露主 session 状态。
- `agent-loop/src/runtime/agent-heartbeat-runtime.ts`
  - 从 message runtime 拆出的独立 heartbeat。
  - 负责 tick agent state、扫描 pending inbound、触发 initiated behavior/sleep events、calling 状态下驱动 talk loop。
- `agent-loop/src/application/run-chat-loop.ts`
  - 逐步改为构建 chat loop 启动参数：prompt、append context、tool specs、tool execution。
- `agent-loop/src/application/run-talk-loop.ts`
  - 逐步改为构建 talk loop 启动参数：talk prompt、transcript messages、stream output handlers、tool execution。

### 迁移步骤

1. [done] 将 `agent-loop/src/runtime/agent-loop-runtime.ts` 改名为 `agent-state-runtime.ts`，更新 import/export，保持行为不变。
2. [done] 新建 `agent-loop/src/runtime/agent-loop-runtime.ts`，维护全局 `activeMainLLMSession`、running 状态和 interrupt，并通过注册的 chat/talk runner 统一发起 loop run。
3. [done] 引入 `activeMainLLMSession` 命名和主 session 状态 port；`messagingTools` 默认 `check_chat` scope 已从该 port 获取 session boundary，不再依赖内部 `activeLLMSession/checkChatCallsInLLMSession` 猜测。
4. [done] 将 message runtime 中 heartbeat timer/pause/resume、tick、pending 扫描和 generated/talk 触发编排迁移到 `agent-heartbeat-runtime.ts`；message runtime 保留 ingest、store、pending set 和具体任务回调。
5. [done] 普通 inbound、manual process、wait_chat resume、initiated behavior、sleep cocoon events 的 loop 发起统一经 heartbeat/task 路径调用 `agent-loop-runtime.requestRun(...)`。
6. [done] talk runtime 外层自旋已改为 ready/claim 模式，内层 backpressure 已接入真实待播输出量；播放后的下一轮通过 ready 标记交回 heartbeat，function-call/tool-result follow-up 在同一次通用 run loop 内完成，不再交给 heartbeat。
7. [done] 从 `run-chat-loop.ts` 抽出通用 loop execution spec，chat 走 `runAgentLoopExecutionSpec(...)`，保持行为一致。
8. [done] 将 `run-talk-loop.ts` 改为 talk loop spec 构建器，并接入通用 loop executor；talk 首轮构筑 active LLM session prefix，后续由 `talkRuntime.buildNextLoopMessagePatch(...)` 返回 `{ replaceFrom, messages }` 替换 prefix 后的 runtime transcript 尾部。
9. [done] 删除旧兼容层和历史配置/接口残留，更新测试与文档。

### 当前已知风险

- `wait_chat` resume 依赖主 session 中未完成 tool call，后续迁移 llm-session 存储层 pointer 时必须保留 pending tool result 拼接语义。
- talk 对延迟敏感；calling 状态下 heartbeat 可能需要短 tick 或事件唤醒，而非固定 1 秒。
- `messagingTools` 的默认 `check_chat` scope 必须由主 loop/session 状态明确决定，不能再由工具私有计数跨 agent 边界推断。
- `activeMainLLMSession` 当前只证明 loop 运行态唯一；llm-session 的 archive/current pointer 仍由 `activeLLMSessionRuntime` 维护，并保留 chat/talk agentId 切换行为。

## Capability tool output target refactor

目标：LLM session 构筑仍通过统一 `toolNames` 暴露工具；工具能否使用不由 `requester/channel` 决定。`requester` 只描述本次 tool call 来源，产生 `AgentOutput` 的工具通过 capabilities 层统一解析投递目标。

### 当前状态

1. [done] `llm-gateway`/`AgentCore` 的 `toolNames -> getTool -> buildTools` 注册链路保持不变；chat/talk 不减少 tool call 暴露。
2. [done] 新增 `capabilities/src/tool-output-target.ts`，提供统一 `ToolOutputTargetResolver`。
3. [done] `messaging/photo/shell/bookcase/sleep-cocoon` 工具运行时接入统一 resolver。
4. [done] `webrtc_voice` 这类非消息 requester 不再被当作图片/文本投递 channel；工具输出回落到当前默认消息目标。
5. [done] 新增覆盖：voice call requester 触发 `selfie` 时，开始通知和图片输出都投递到默认消息目标。

### 约束

- 不通过隐藏 talk tool、减少 toolNames 或按 channel 裁剪工具来规避问题。
- 具体工具仍可以定义自己的固定输出语义，但公共投递目标解析必须走 capabilities 层接口。
- 后续如果新增非消息 requester，应扩展 resolver 配置，而不是在单个 tool 内硬编码 channel fallback。
