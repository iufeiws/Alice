# SubAgent 工具接口重构计划

## 一、目标

根据 `src/capabilities/tools/subagent/README.md` 中的审核批注，收缩 LLM 可见的 `SubAgent` 工具接口，去掉调用方不需要理解的 invocation、Pi 原生 tree/context、内部监听状态和 session 列表等细节。

重构后的外部接口只保留七个 action：

```text
spawn | messages | send | status | wait | cancel | fork
```

本计划只定义重构范围、接口用法、实施顺序与验收标准，不修改运行时代码。本次计划不会把任何新文本加入 LLM request 或 prompt layer。

## 二、设计原则

1. `SubAgent` 对 LLM 仍是一个工具，不拆成七个独立 ToolPlugin；七个 action 共享同一个 session 标识和错误模型。
2. LLM 可见接口只暴露完成任务所需的信息。Pi invocation id、队列状态、completion 列表和原生 entry tree 留在实现内部。
3. worker 内部监听接口与 LLM 可见接口分离。completion watcher 仍可读取完整 invocation snapshot，不能因为公开 `status` 变短而丢失幂等投递所需数据。
4. 删除旧 action，不增加兼容性 fallback；旧的 `start`、`read` 以及 `send.mode` 应直接变为非法输入。`list` 作为未来实现计划只以注释代码保留，不暴露且不可访问。
5. `messages` 的选择表达式使用受限解析器，不使用 `eval`，也不把表达式转交给 shell 或 Python。
6. 消息筛选、切片和计数必须共用一个实现入口，避免 `messages`、`status`、`wait` 对“可见消息”的定义不一致。
7. 所有公开行为变更均增加测试；错误继续抛出并由统一工具执行流程处理，不增加吞错用的 `try/catch`。

## 三、已确认的契约

1. `messages.access` 使用 Python 数组的索引和切片语义；`:3` 表示过滤后可见消息中的前三条。
2. 消息处理顺序固定为：先过滤出可见消息，再对过滤结果执行索引或切片。
3. 状态只使用一个 `status` 字段表达，不再用 `idle` 与 `invocationStatus` 两个字段组合描述。
4. `status` 的完整状态集合为 `queued | running | completed | failed | interrupted | timed_out | aborted`。
5. `wait` 使用联合返回：仍在处理时返回 `{ status: "running" }`；完成时返回状态和最新 assistant 消息；其他终态只返回状态。
6. `cancel` 成功返回字符串 `"cancelled"`。

## 四、最终 description 拼接文本

`SubAgent` 最终工具 `description` 必须由以下七行具体用法按此顺序直接拼接，Tool Preview 与实际 LLM request 使用同一份文本：

```text
spawn：创建新的持久化 SubAgent session 并提交第一条任务消息，立即返回 sessionId，不等待任务完成。
messages：先过滤指定 session 的可见 user/assistant 消息，再用 access 按 Python 索引或切片语义读取，例如 -1、:3、2:。
send：向已有 session 提交一条新任务消息并立即返回原 sessionId；需要结果时再调用 wait 或 messages。
status：非阻塞查询 session 的单一状态、最后更新时间和可见消息数量，状态包含 queued、running 及五种终态。
wait：等待 session 当前任务结束；完成时返回最新 assistant 消息，等待结束时仍未完成则返回 running，其他终态只返回状态。
cancel：请求取消 session 当前运行或排队的任务，成功返回 cancelled，session 保持可复用。
fork：从指定 session 创建独立的新 session，可用 entryId 指定历史分支点，成功返回新 sessionId。
```

## 五、目标工具接口与用法描述

以下“返回”均指统一工具结果 `{ callId, ok: true, output }` 中的 `output`。

### 1. `spawn`

用法描述行：`spawn：创建新的持久化 SubAgent session 并提交第一条任务消息，立即返回 sessionId，不等待任务完成。`

用法：

```ts
{
  action: "spawn";
  message: string;
  timeoutSeconds?: number;
}
```

成功返回：

```ts
{
  sessionId: string;
}
```

约束：

- `message` 必须是非空字符串。
- `timeoutSeconds` 必须是正数。
- 不向 LLM 返回 `invocationId`、`queued/running` 等内部调度信息。
- 内部仍需记录 invocation id，以维持 completion 去重和 activity hold 的一一配对。

### 2. `messages`

用法描述行：`messages：先过滤指定 session 的可见 user/assistant 消息，再用 access 按 Python 索引或切片语义读取，例如 -1、:3、2:。`

用法：

```ts
{
  action: "messages";
  sessionId: string;
  access: string;
}
```

成功返回：

```ts
Array<{
  role: "user" | "assistant";
  content: unknown;
}>
```

约束：

- `sessionId` 和 `access` 必填。
- `access` 使用 Python 数组索引与切片语义，首版只接受单个整数或 `start:end`；非法、越界处理规则必须有明确测试。
- 固定先过滤可见消息，再对过滤后的数组执行 `access`。
- 不再暴露 `context`、`messages`、`tree` 三种 view。
- 丢弃 system、tool use、tool result、progress、thinking 以及审核意见指定的旧 assistant 内容。
- assistant 消息只保留不含 tool call 的最终自然语言消息。
- 返回值直接是筛选后的消息数组，不再包裹 session、idle 或 invocation 状态。

### 3. `send`

用法描述行：`send：向已有 session 提交一条新任务消息并立即返回原 sessionId；需要结果时再调用 wait 或 messages。`

用法：

```ts
{
  action: "send";
  sessionId: string;
  message: string;
  timeoutSeconds?: number;
}
```

成功返回：

```ts
{
  sessionId: string;
}
```

约束：

- 删除 `mode`，不再向 LLM 暴露 `prompt | steer | follow_up`。
- worker 只走单一发送语义；不能收到未知 mode 后静默回退成 `prompt`。
- 不返回 `invocationId` 或 invocation 状态。
- 内部仍需创建 invocation 记录、启动 watcher 并取得 activity hold。

### 4. `status`

用法描述行：`status：非阻塞查询 session 的单一状态、最后更新时间和可见消息数量，状态包含 queued、running 及五种终态。`

用法：

```ts
{
  action: "status";
  sessionId: string;
}
```

成功返回：

```ts
{
  updatedAt: string;
  messages: number;
  status: "queued" | "running" | "completed" | "failed" | "interrupted" | "timed_out" | "aborted";
}
```

约束：

- `messages` 统计与 `messages` action 使用同一套可见消息筛选规则。
- 只使用 `status` 一个字段表达状态，不再组合 `idle` 与 `invocationStatus`。
- 不返回 `sessionId`、`idle`、`invocationStatus`、`createdAt`、`terminalCompletions` 或 `lastInvocation`。
- `updatedAt` 沿用 Pi session 的更新时间格式，不另行生成时间戳。

### 5. `wait`

用法描述行：`wait：等待 session 当前任务结束；完成时返回最新 assistant 消息，等待结束时仍未完成则返回 running，其他终态只返回状态。`

用法：

```ts
{
  action: "wait";
  sessionId: string;
  timeoutSeconds?: number;
}
```

成功返回使用联合类型：

```ts
type SubAgentWaitOutput =
  | { status: "running" }
  | {
      status: "completed";
      message: {
        role: "assistant";
        content: unknown;
      };
    }
  | { status: "failed" | "interrupted" | "timed_out" | "aborted" };
```

约束：

- 只有 `completed` 才返回本次完成产生的最新 assistant 消息。
- 等待到指定时间但任务仍未结束时返回 `{ status: "running" }`，这不是错误，也不附带任何旧消息。
- 失败、中断、超时终止或取消时只返回对应终态，不返回旧消息。
- 必须定义 session 尚无 assistant 消息时的明确错误。
- 不返回 invocation、completion 或 session 元数据。

### 6. `cancel`

用法描述行：`cancel：请求取消 session 当前运行或排队的任务，成功返回 cancelled，session 保持可复用。`

用法：

```ts
{
  action: "cancel";
  sessionId: string;
}
```

成功返回：

```ts
"cancelled"
```

约束：

- 不再返回完整 `status` snapshot。
- “取消请求已提交”与“任务已进入 aborted 终态”不能混为同一保证；描述与返回值必须准确对应 worker 实际语义。
- completion watcher 仍负责观察最终终态、投递 completion 并释放 activity hold。

### 7. `fork`

用法描述行：`fork：从指定 session 创建独立的新 session，可用 entryId 指定历史分支点，成功返回新 sessionId。`

用法：

```ts
{
  action: "fork";
  sessionId: string;
  entryId?: string;
}
```

成功返回：

```ts
{
  sessionId: string;
}
```

约束：

- 返回的 `sessionId` 是新 session，而不是源 session。
- 空字符串 `entryId` 非法，不做“不传”的兼容性 fallback。
- fork 不自动提交新消息；需要继续任务时再调用 `send`。

### 暂不开放的 `list`

`list` 是未来实现计划，本次不开放：

1. 不写入 LLM 可见 schema，不出现在最终 `description`，也不出现在 Tool Preview。
2. 不加入当前可解析的输入联合，不建立可执行的 action 分发路径；外部传入 `{ action: "list" }` 时仍触发 `invalid_subagent_input`。
3. 未来 `list` action 的类型、解析和执行草案以明确的注释代码保留，不能形成任何隐藏可调用路径。
4. worker 的 session 枚举能力继续保留，供未来实现或已有内部调用者使用，不删除 host client/runtime 的相关方法。
5. 注释必须标明这是“未来计划、当前不暴露”，避免维护者误认为是废弃代码或兼容性 fallback。

## 六、模块与 seam 调整

### 1. LLM 可见工具 seam

修改：

- `src/capabilities/tools/subagent/profile.ts`
- `src/capabilities/tools/subagent/src/index.ts`

工作内容：

1. 将输入联合类型改为七个目标 action。
2. 更新 JSON Schema 的 `oneOf`，为每个 action 和参数补充已确认的 description，并把七行用法拼接为最终工具 `description`。
3. `start` 重命名为 `spawn`，`read` 重命名为 `messages`；`list` 仅保留不可执行的注释草案。
4. 删除 `read.view` 和 `send.mode`。
5. 将 worker/runtime 的详细对象投影为最小公开返回值。
6. 保持统一 `ToolPlugin.execute` 路径，不在 loop 中按 action 或 requester 新增执行拦截。

### 2. 可见消息投影模块

在 Pi worker 上下文内建立一个唯一的内部入口，负责：

1. 从 Pi session entries 取得消息。
2. 识别 user、assistant、tool call、tool result、thinking、progress 等类型。
3. 先过滤可见消息，再执行访问表达式。
4. 返回稳定的公开消息结构。
5. 为 `messages` 返回、`status.messages` 计数、`wait` 最新消息复用同一实现。

该逻辑不应复制到 `profile.ts`、SubAgent ToolPlugin 和 HTTP client 三处。Pi 原生 entry 结构知识应集中在 worker adapter 一侧，以保持 locality。

访问表达式解析器首版只实现单个整数及 `start:end`。语义小且边界稳定，可在该模块内手写严格解析器；不引入能执行任意表达式的依赖。

### 3. 内部监听 seam

现有 `PiSessionSnapshot` 和 `PiInvocationCompletion` 继续作为 host 与 worker 之间的内部监听接口，服务于：

- completion 幂等投递；
- 多 invocation 不漏通知；
- activity hold 释放。

公开 `status` 和 `wait` 不应直接复用这个内部对象作为返回值。应新增明确的公开 projection 类型，或由 `PiWorkerRuntime` 提供面向 SubAgent 工具的窄方法，防止内部字段再次泄漏。

### 4. worker HTTP adapter

检查并按最终接口调整：

- `src/contexts/bash-sandbox/wrappers/worker.mjs`
- `src/contexts/pi-worker/src/pi-worker-client.ts`
- `src/contexts/pi-worker/src/contracts.ts`
- `src/contexts/pi-worker/src/pi-worker-runtime.ts`

优先保留内部 route 完成 watcher 所需能力，再为 `messages`/`wait` 增加窄返回；不要让一个 route 同时承担“内部完整 snapshot”和“LLM 最小返回”两套不兼容语义。

## 七、分阶段实施顺序

### 阶段 0：按已确认契约建立类型

1. 用类型固化七态 `status`、`wait` 联合返回和 `cancel -> "cancelled"`。
2. 用输入/输出示例固化先过滤后切片的 `messages` 语义。
3. 将已确认的七行 action 用法按顺序拼接为最终工具 `description`。

### 阶段 1：先建立消息投影与测试

1. 提取单一可见消息投影入口。
2. 实现严格的访问表达式解析。
3. 覆盖角色过滤、tool call/result 丢弃、thinking/progress 丢弃、旧 assistant 处理、负索引、开放区间、空结果和非法表达式。
4. 让计数和最新 assistant 查询复用该入口。

### 阶段 2：重构 worker/runtime 内部接口

1. 增加窄的 messages/status/wait 返回类型。
2. 保留 watcher 使用的完整 snapshot，不改变 completion 投递顺序。
3. 将 `send` 固定为一个明确语义，删除 mode 透传和 worker 对未知 mode 的默认回退。
4. 将 cancel 公开返回压缩为 `"cancelled"`，同时继续异步观察真正终态。
5. 保留 worker/host runtime 的 list 能力及工具层注释草案，但确保它不进入公开 schema、输入解析或执行分发；删除不再使用的 read-view 浅转发。

### 阶段 3：替换 LLM 可见工具接口

1. 更新 `SubAgentInput`、`parseInput`、action 分发和输出投影。
2. 更新 `profile.ts` 的 schema 与已确认的七行工具描述。
3. 删除旧 action 和参数，不做兼容性 fallback；保留 `list` 的注释草案但不形成可访问代码路径。
4. 核对 prompt/tool preview：预览必须与实际发送给 LLM 的工具 schema 完全一致，不得出现隐藏 description 或旧 schema。

### 阶段 4：更新测试和中文文档

1. 更新 `tests/contexts/pi-worker/pi-worker-runtime.test.ts` 的 SubAgent 工具契约测试。
2. 更新 `tests/contexts/pi-worker/pi-worker-integration.test.ts` 的 worker 集成测试。
3. 增加逐 action 的成功、非法输入和错误传播测试。
4. 将 `src/capabilities/tools/subagent/README.md` 从带批注的旧返回格式改写为最终中文用法文档。
5. 检查旧设计文档是否只作为历史记录保留；不静默篡改已经完成的历史计划。

### 阶段 5：验证

依次运行：

```text
npm run typecheck
node --test <SubAgent/Pi worker 相关测试文件>
npm test
npm run build
```

同时人工检查：

1. Tool Preview 中只显示七个 action。
2. 实际 LLM request 与 Tool Preview 的 schema、description、action 顺序一致。
3. `spawn`/`send` 后 activity hold 正确取得并逐 invocation 释放。
4. `wait` 返回本次完成产生的最新 assistant 消息，不返回旧消息。
5. cancel 后 session 可再次 send。
6. 重启后不重放历史 completion：投递只走 watcher 实时路径，漏投递可接受。

## 八、测试矩阵

| action | 成功路径 | 必测错误/边界 |
| --- | --- | --- |
| `spawn` | 立即返回新 `sessionId`，内部 watcher 已启动 | 空 message、非正 timeout、preset 缺失 |
| `messages` | 按 access 返回筛选后的消息 | 非法表达式、负索引、开放切片、空结果、越界、各类丢弃消息 |
| `send` | 返回原 `sessionId`，创建新 invocation | session 不存在、空 message、旧 mode/额外字段被拒绝 |
| `status` | 返回 updatedAt、可见消息数和单一七态 status | queued、running、从未完成、失败/超时/中断/取消五种终态 |
| `wait` | completed 返回最新 assistant；仍在处理返回 running；其他终态只返回状态 | 等待结束仍运行、无 assistant、旧 assistant 不得误返回、AbortSignal |
| `cancel` | 返回 `"cancelled"`，最终 completion 正常投递 | 无活跃任务、排队任务、重复 cancel、worker abort 失败 |
| `fork` | 返回不同的新 `sessionId` | 源 session 不存在、空/不存在 entryId、fork 后独立发送 |

跨 action 回归：

- 旧 `start/read` 全部拒绝；未开放的 `list` 同样无法通过输入解析和执行分发。
- `send.mode` 被拒绝。
- 所有 action 的额外字段被 JSON Schema 和运行时解析一致拒绝。
- ToolPlugin 公开结果不含 `invocationId`、`idle`、`terminalCompletions` 等内部字段。
- 多 invocation completion 不丢失、不重复投递，activity hold 数量归零。

## 九、完成标准

1. LLM 可见 `SubAgent` 只有七个目标 action，旧 action 无兼容路径；未来 `list` 仅有明确注释草案，当前不可访问。
2. 每个 action 在 schema 和 README 中都有一致、明确的一行具体用法；七行按固定顺序拼接进最终工具 `description`。
3. `messages`、`status.messages`、`wait` 共用同一可见消息投影入口。
4. 公开返回不泄漏 Pi invocation 与内部 watcher 字段。
5. completion 投递、消息投递目标解析和 activity hold 行为无回归。
6. Prompt/Tool Preview 与实际 LLM request 完全一致，没有隐藏 prompt 文本或 schema 差异。
7. typecheck、相关测试、全量测试和 build 全部通过。
