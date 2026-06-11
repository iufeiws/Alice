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

- `activeMainLLMSession` 是全局唯一主 LLM session；`archive/current` pointer 指向当前主 session，chat/talk 混用这条主 session 语义。
- 当前阶段保留 `ensureActiveLLMSession(agentId)` 遇到不同 `agentId` 时切 session 的行为，因为 chat/talk static prefix 不兼容。
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
2. [done] 新建 `agent-loop/src/runtime/agent-loop-runtime.ts`，维护全局 `activeMainLLMSession`、running 状态和 interrupt。
3. [done] 引入 `activeMainLLMSession` 命名和主 session 状态 port；让 `messagingTools` 从该 port 获取 session boundary，不再依赖内部 `activeLLMSession/checkChatCallsInLLMSession` 猜测。
4. [done] 将 message runtime 中 heartbeat timer/pause/resume 迁移到 `agent-heartbeat-runtime.ts`；message runtime 保留 ingest、store、pending 标记和具体消息处理任务。
5. [done] 将普通 inbound、manual process、wait_chat resume、initiated behavior、sleep cocoon events 的发起统一改由 heartbeat 调 `agent-loop-runtime.requestRun(...)`。
6. [done] 将 talk runtime 的自旋改为 ready/claim 模式；calling 状态下 heartbeat 每秒向 talk runtime 询问是否可以发起下一轮。
7. [todo] 从 `run-chat-loop.ts` 抽出通用 loop spec，先让 chat 走通用执行器，保持行为一致。
8. [todo] 将 `run-talk-loop.ts` 改为 talk loop spec 构建器，并接入通用 loop executor。
9. 删除旧发起点和兼容层，更新测试与文档。

### 当前已知风险

- `wait_chat` resume 依赖主 session 中未完成 tool call，迁移时必须保留 pending tool result 拼接语义。
- talk 对延迟敏感；calling 状态下 heartbeat 可能需要短 tick 或事件唤醒，而非固定 1 秒。
- `messagingTools` 的默认 `check_chat` scope 必须由主 loop/session 状态明确决定，不能再由工具私有计数跨 agent 边界推断。
