# 沙箱重构第二步：Pi session 工具化、冗余清理与收敛设计

## 文档状态

- 状态：已确认变更，等待实施。
- 范围：以 [2026-08-04_pi-worker-agent-refactor.md](./2026-08-04_pi-worker-agent-refactor.md) 为基础，落实审阅后确认的变更与清理。
- 冲突处理：本文件覆盖第一步文档中“一个 session 对应一个一次性 task”、per-session relay bind、自造 task event/cursor 和 completion inbound event 等冲突设计。
- 原则：不做对 Pi SDK 的非必要 API 推定；不维护 Alice 自有的 session/task 镜像；能直接使用 Pi session、entry、tool 和 retry 行为时不复制实现。

## 核心模型修正

### Pi session 不是一次性 task

- 一个 Pi session 是可持续读取、继续、等待、中止和分支的持久化 AgentSession，不在一次 prompt 完成后进入不可逆 terminal 状态。
- `SubAgent.start` 创建新 Pi session 并发起第一次 invocation；后续 `SubAgent.send` 可以继续使用同一 session。
- 一次 `start` 或 `send` 产生一次 invocation。queued、running、failed、interrupted、timeout 等状态属于 invocation，不属于 session。
- `sessionId` 由 Pi 生成并永久定位 session；invocation id 使用 Pi JSONL 中对应的稳定 entry id，不生成 Alice task id。
- session 处于 idle 后仍可再次调用；`cancel` 只中止当前 invocation，不删除或终结 session。

### 真相源

- Pi JSONL session 及其原生 entries 是 session、消息、工具调用、分支和上下文的真相源。
- Alice 不再持久化 task、transcript、system prompt、usage、tool event、cursor 或 terminal result 的副本。
- Worker 内存只保留活跃 AgentSession、invocation 队列和运行中索引；这些都是可重建的运行时 projection。
- 为了在 invocation 完成后主动向 Alice 与用户投递消息，只允许追加最小 `alice_pi_invocation` custom entry，保存 Pi invocation entry id、调用时的消息目标和 timeout。原始 prompt、结果和 transcript 不复制进 custom entry。

## 已确认变更

### 1. session id 采用 Pi 生成

- 不向 Pi 传外部 id，不假设 `SessionManager` 接受自定义 id。
- `worker.createSession` 创建真实持久化 Pi session，并从实际 Pi 返回对象或 `SessionManager` 取得 `sessionId`。
- 删除 worker 自造的 `cryptoRandomId`；删除 `SessionManager.create(..., { id })` 和 `SessionManager.inMemory(..., { id })` 传参。
- `preview` 同样使用 Pi 生成的 in-memory session id，返回 `{ sessionId, systemPrompt }`；Alice 删除 `createId("pi_preview")`。
- 具体取 id、打开 session、读取 entry、分支和恢复 session 的 API 形态必须在真实安装版本集成测试中核对，不在实现中增加猜测式 fallback。

### 2. SubAgent 改为完整 session 协作工具

首版提供以下 action：

```ts
type SubAgentInput =
  | { action: "start"; message: string; timeoutSeconds?: number }
  | { action: "list" }
  | { action: "read"; sessionId: string; view?: "context" | "messages" | "tree" }
  | { action: "send"; sessionId: string; message: string; mode?: "prompt" | "steer" | "follow_up"; timeoutSeconds?: number }
  | { action: "status"; sessionId: string }
  | { action: "wait"; sessionId: string; timeoutSeconds?: number }
  | { action: "cancel"; sessionId: string }
  | { action: "fork"; sessionId: string; entryId?: string };
```

- `start`：创建 session、追加 invocation 元数据并发送首次 prompt，返回 Pi `sessionId` 与当前 invocation 状态，不等待 LLM 完成。
- `list`：使用 Pi `SessionManager.list/listAll` 能力列举 Worker session root 内的 session。
- `read`：直接读取指定 session。`context` 返回当前有效模型上下文，`messages` 返回当前分支消息，`tree` 返回 Pi 原生 entry tree；不返回 Alice 自造 transcript。
- `send`：打开或复用指定 session。idle 时使用 `prompt`，运行中可使用 Pi 原生 `steer` 或 `followUp` 语义。
- `status`：返回 session 是否 idle，以及当前 invocation 的 queued/running/failed/interrupted/timeout 状态；不使用不可逆 session terminal 状态。
- `wait`：有限时间等待当前 invocation 状态变化或完成，超时只结束 wait 调用，不取消 invocation。
- `cancel`：调用 Pi `AgentSession.abort()` 中止当前 invocation，session 仍可继续使用。
- `fork`：使用 Pi 原生 session tree/fork 能力产生新 session，返回 Pi 生成的新 `sessionId`。
- 不提供 `retry` action。Pi 自己处理瞬时上游错误的原生自动 retry；Agent 若要再次尝试，使用 `send` 给出新指令，或先 `fork` 再 `send`。
- 不按 requester、channel、创建者或调用来源限制 session。Worker session root 内可列举的 session 均可被 `read/send/status/wait/cancel/fork` 调用。
- Tool 可用性仍只由 LLM request 的 visible tools 决定；执行期不增加 session ownership 或 requester 二次拦截。

### 3. 队列与并发改为 invocation 语义

- `maxQueueSize` 限制等待执行的 invocation 数量，不限制历史 session 数量。
- `maxConcurrency` 限制同时运行的 invocation 数量。
- 同一个 session 不并发执行两个普通 prompt；运行中的额外输入只走 Pi 原生 `steer/followUp` 队列。
- queued invocation 已经属于真实 Pi session，但尚未开始 prompt。
- Worker 重启时，正在运行或排队但未完成的 invocation 标记为 interrupted；对应 session 保留且之后仍可 `send`。
- Worker 内存 sessions Map、active invocation 索引和 watcher 轮询是允许的运行时 projection，不成为持久化真相源。

### 4. relay 删除 per-session bind

当前 Pi 插件只有一个 `llmPresetName`，没有必要为每个 session 维护 preset 白名单。capability 直接持有创建时的 preset snapshot：

```ts
type PiRelayCapability = {
  tokenHash: string;
  sandboxId: string;
  active: boolean;
  preset: PiPresetSnapshot;
};
```

- 删除 `sessionPresets` Map、`bindSession()`、`releaseSession()` 及 `pi_relay_session_not_bound`。
- 所有持有当前 Worker capability token 的 Pi session 都能使用同一 capability preset，不按 session id 限制。
- relay 继续校验 capability token、固定请求路径、body size 和 preset model；继续隐藏真实 upstream URL/API key，不能退化为开放代理。
- session id 可以作为 usage/诊断关联信息传递，但不参与授权。
- preset 配置变更通过配置重载/容器重建产生新 capability snapshot；不在运行中暗改旧 capability。
- `SubAgent.start/send` 不再包含 relay 绑定阶段，preview 也不产生 capability session 状态。

### 5. completion 使用 Message Store `both` 消息

Message Store 的 direction 扩展为：

```ts
type MessageDirection =
  | "inbound"
  | "outbound"
  | "both";
```

`both` 表示同一个逻辑消息同时面向 Alice 与用户：

- Alice 侧：按项目配置的用户 Albert 的消息语义进入会话上下文和 Core pending 队列。
- 用户侧：复用现有 system notice 的格式和 OutputRouter 发送路径，以 `<-内容->` 形式发送到 invocation 保存的原消息目标。
- `both` 是结构化 direction，不向消息正文追加 `[subagent]`、固定说明或其他隐藏 prompt 文本。
- `senderRole` 继续使用 Alice 侧需要的 `user` 语义，不新增 `subagent` sender role。
- `status` 的 `sending/sent/send_failed` 表示面向用户的 system notice 发送状态。
- `isRead` 只表示 Alice 是否读取该消息，只能由 Alice 的读取流程设置；外部用户 read receipt 不得修改 `direction="both"` 消息。
- `coreProcessedAt/coreBatchId` 独立表示 Alice Core 是否处理该消息。
- pending Core 查询必须包含尚未处理的 `both` 消息，且不能因为外部发送状态或用户 read receipt 跳过。
- timeline/context 格式化遇到 `both` 时按 Albert 消息展示，不得因为它同时发送给用户而显示成 Alice outbound。
- 发送用户时复用现有 system notice 的规范化、格式化和 OutputRouter 行为，但不得额外插入第二条 outbound/system 消息。

每次 invocation completion 的投递流程：

```text
1. 从 Pi 原生 session entries 取得最终 assistant 内容或准确错误
2. 在 Message Store 创建或取得唯一的 both 消息
3. 将该消息加入 Alice pending/Core 处理路径
4. 用现有 system notice 形式把同一消息发送给 invocation target
5. 分别更新 isRead、coreProcessedAt 与 sending/sent/send_failed
```

- 不增加泛化 `originId`。Message Store 使用明确的 `piSessionId + piInvocationId` 关联并去重 completion；两者都来自 Pi。
- `piSessionId + piInvocationId` 需要数据库唯一约束或等价的原子 upsert，避免 Worker/Alice 重连后重复创建逻辑消息。
- Message Store 的 `both` 记录接管 completion 写入、Alice 处理和用户发送状态；删除 session 级 `completionDelivered`、`terminalResult`、`terminalError` 和 `pi:<sessionId>:<status>` 去重规则。
- 本步骤沿用现有 system notice 的发送保障，不另造 exactly-once 外部消息协议；外部渠道在“已接收但本地尚未标记 sent”时仍可能产生 at-least-once 重发。

### 6. 记忆归纳完整迁移到 Pi 工具

- Memorize 直接复用 Pi tool adapter 的动态 Read/Edit definitions 与统一 `PiWorkerRuntime.executeTool` 路径。
- 删除 Memorize 自有的 `memoryToolDefinitions()`、`memoryTools()`、`memoryToolNames`、`createMemorySelfTalkToolPlugin()` 及 `src/contexts/memory/src/tools.ts`。
- 删除 `src/contexts/memory/src/induction.ts` 中 `createFileTools` 注册、旧 `file_path` 参数适配和旧 Read/Edit tool-call 记录分支。
- `MemorySummaryDeps` 及 sleep/admin/runtime wiring 改为注入 `PiWorkerRuntime`，不再注入一套只供 Memorize 文件工具使用的 Bash wrapper。
- 旧 `createFileTools` 的 Read/Edit/Grep wrapper 全部删除；`createGlobTool` 只作为普通 Alice 主 Agent 工具保留，不注入 Memorize 或 Pi SubAgent。
- Memorize 的 tool definitions、实际 execute 和 preview 必须来自同一个 Pi adapter，不能继续暴露旧 `file_path` schema。
- 不保留旧工具兼容 fallback。
- 本变更不自行修改、追加或重排任何 Core/Memorize prompt layer。若现有 Prompt 编辑器 layer 含已删除工具的 fake tool call，实施前必须在编辑器/preview 中展示实际影响并另行确认；运行时不得暗中改写。

### 7. 容器侧丢弃采样参数

- 容器内 Pi 只接收构建 model runtime 所需的 `model`、`maxTokens`、`supportsImage`、`reasoning`。
- `temperature`/`extraParams` 不进入容器或 worker contracts。
- relay 继续对每个上游请求注入 capability snapshot 的 `temperature`、`extraParams` 和 `max_tokens`，保证 Alice preset 仍然生效。
- 删除 `piModelConfig()` 死代码及 contracts/runtime/worker 中的 `temperature`/`extraParams` 传递字段。

### 8. relay 并发限制

- relay 维护已接受且尚未结束的上游 LLM 请求计数，上限使用 `maxConcurrency`。
- 请求通过 token、路径、body、model 校验后，在调用 upstream 前原子占用槽位；无槽位时不建立 upstream 请求，直接返回 429 `pi_relay_concurrency_limit`。
- 达到上限不取消、不截断也不改变已经建立的流式或非流式请求。
- 非流式请求在 response body 处理完成或失败后释放槽位。
- 流式请求在 upstream stream 正常结束、报错或取消后释放槽位；不能在 `handle()` 返回 `Response` 时提前释放。

### 9. Pi Worker 默认使用网络

- `BASH_SANDBOX_NETWORK` 默认值从 `none` 改为 `configured`。
- `validateBashSandboxConfig` 对 `piWorker.enabled && network === "none"` 返回 `invalid_pi_worker_network`。
- Admin Bash sandbox 设置显示实际的 `configured` 值；Pi Worker 启用时不能保存为 `none`。
- 现有未显式配置该环境变量的安装按新默认值启动，不增加兼容 fallback。
- 权限说明必须明确：Pi Worker 与 Bash 共用容器，因此 `configured` 同时表示容器内 Bash 具有 Docker bridge 网络能力，不得把它描述为只有 Worker 能访问 relay。

### 10. preview 只使用 in-memory Pi session

- preview 解析 capability preset 的 model 行为字段，创建 in-memory Pi session，读取实际 `session.agent.state.systemPrompt`，然后在 `finally` 中 dispose。
- preview 不发 LLM 请求、不经过 relay、不写持久化 session、不创建 `both` 消息。
- 删除 `preparePreviewSession` 中的 bind 及 capability session 状态。

### 11. restart 后刷新工具注册表

- `PiWorkerRuntime.restart()` 获取新 Worker health/tool definitions 后、对调用方返回前刷新默认工具注册表。
- wake 的进程内重建必须执行刷新；admin/mount/config 导致完整进程重启时，沿用 startup 已有刷新路径。
- 刷新失败时 restart 失败并显式报错，不在旧 definitions 下继续运行。

### 12. 第一步文档术语对齐

- 删除第一步文档中 `taskId === sessionId` 和“session 是一次性 task”的表述。
- `SubAgent` 全部 action 统一使用 `sessionId`；invocation 只使用 Pi entry id。
- completion、timeout、cancel、interrupted 和 queue 文档全部改为 invocation 语义。

## 应删除的冗余状态与实现

| 项 | 处置 |
|---|---|
| worker 自造 `cryptoRandomId` | 删除，使用 Pi session/entry id |
| worker `*.json`、`persist()`、`loadPersistedSessions()` | 删除，只使用 Pi JSONL 与 Message Store |
| Alice 自造 `PiSessionEvent[]`、cursor | 删除；需要上下文时直接读 Pi entries |
| session 级 task/status/terminal/result/error/completionDelivered | 删除，session 可重复 invocation |
| relay `sessionPresets`、bind/release | 删除，preset snapshot 属于 capability |
| worker/contract 中 `temperature`、`extraParams` | 删除，relay 保留注入 |
| `piModelConfig()` | 删除 |
| Memorize 自有 tools.ts 与旧 file tool wrapper | 删除，完整使用 Pi adapter |
| preview session preset 绑定 | 删除 |
| `activeTasks` 的一次性 task 语义 | 删除，改为活跃 invocation/session projection |

允许保留的运行时 projection：Worker 活跃 AgentSession Map、invocation queue、active invocation Set、宿主 watcher/等待器和最新 health/tool definitions snapshot。

## 实施顺序

1. session/invocation contracts 与 SubAgent 完整 action 重构。
2. Pi 生成 session/entry id，删除 Alice task id 与 JSON 双存储。
3. relay capability preset 化，删除 per-session bind，并清理采样参数传递。
4. Message Store 增加 `both` direction、Pi invocation 关联和 completion 投递路径。
5. relay 并发限制及流式生命周期计数。
6. network 默认值、后端校验与 Admin 设置对齐。
7. preview in-memory 化与 restart 工具注册表刷新。
8. Memorize 完整迁移到 Pi adapter，删除旧 memory/file tools。
9. 更新第一步设计文档的冲突术语和验收项。

## 测试与验收补充

### SubAgent/session

- `start` 返回 Pi 生成的 `sessionId`，同一 session 完成后仍可 `send`。
- `list/read(context|messages|tree)/send/status/wait/cancel/fork` 使用真实 Pi session 行为。
- 任意 Worker session root 内 session 均可调用，不按 requester/channel 限制。
- `cancel` 中止当前 invocation 后仍可再次 `send`。
- 不存在 `retry` action；瞬时错误由 Pi 原生 retry 处理。
- queue、timeout、interrupted 和 concurrency 都按 invocation 计算。

### Message Store `both`

- `both` 消息在 Alice 上下文中按 Albert 用户消息显示，同时以 system notice 形式发送给用户。
- 只创建一条 `both` conversation message，不额外插入 outbound/system 副本。
- Alice 读取会设置 `isRead`；用户 read receipt 不改变 `both.isRead`。
- `coreProcessedAt` 与 `sending/sent/send_failed` 独立更新。
- 相同 `piSessionId + piInvocationId` 重复 completion 不创建第二条逻辑消息。
- 重启后未处理的 `both` 消息仍进入 Core pending。

### Relay

- capability 下任意 Pi session 都可请求，不存在 session bind/release。
- token、路径、body、model 和 upstream key 隔离仍有效。
- `maxConcurrency=1` 时，第一条 SSE 保持传输，第二条请求在 upstream 建立前返回 429；第一条结束后第三条才能建立。
- 流式异常和取消会释放并发槽，不影响其他已建立请求。

### Network、preview 与工具

- 未设置 `BASH_SANDBOX_NETWORK` 时配置结果为 `configured`。
- Pi Worker 启用时保存 `network=none` 返回 JSON 错误。
- preview 不产生持久化 Pi session、relay bind 或 Message Store 消息，并始终 dispose。
- Worker 重建后默认 registry 使用新 health 返回的动态 Pi definitions。
- Memorize request definitions 与 execute 都来自 Pi adapter，不再出现旧 `file_path` schema 或旧工具 fallback。
