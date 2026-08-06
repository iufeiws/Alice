# SubAgent 工具接口

`SubAgent` 是一个持久化子 Agent 工具。所有成功结果位于统一工具结果的 `output` 字段：

```ts
{ callId: string; ok: true; output: unknown }
```

## action

### `spawn`

创建新的持久化 SubAgent session 并提交第一条任务消息，立即返回 sessionId，不等待任务完成。

```ts
{ action: "spawn"; message: string; timeoutSeconds?: number }
// output
{ sessionId: string }
```

### `messages`

先过滤指定 session 的可见 user/assistant 消息，再用 access 按 Python 索引或切片语义读取，例如 -1、:3、2:。

```ts
{ action: "messages"; sessionId: string; access: string }
// output
Array<{ role: "user" | "assistant"; content: unknown }>
```

只保留 user 消息和不含 tool call 的 assistant 自然语言消息；system、tool use、tool result、progress 与 thinking 均不返回。`access` 只接受单个整数或 `start:end`；索引越界会报错，切片可以返回空数组。

### `send`

向已有 session 提交一条新任务消息并立即返回原 sessionId；需要结果时再调用 wait 或 messages。

```ts
{ action: "send"; sessionId: string; message: string; timeoutSeconds?: number }
// output
{ sessionId: string }
```

### `status`

非阻塞查询 session 的单一状态、最后更新时间和可见消息数量，状态包含 queued、running 及五种终态。

```ts
{ action: "status"; sessionId: string }
// output
{ updatedAt: string; messages: number; status: "queued" | "running" | "completed" | "failed" | "interrupted" | "timed_out" | "aborted" }
```

### `wait`

等待 session 当前任务结束；完成时返回最新 assistant 消息，等待结束时仍未完成则返回 running，其他终态只返回状态。

```ts
{ action: "wait"; sessionId: string; timeoutSeconds?: number }
// output
{ status: "running" }
  | { status: "completed"; message: { role: "assistant"; content: unknown } }
  | { status: "failed" | "interrupted" | "timed_out" | "aborted" }
```

### `cancel`

请求取消 session 当前运行或排队的任务，成功返回 cancelled，session 保持可复用。

```ts
{ action: "cancel"; sessionId: string }
// output
"cancelled"
```

返回值只表示取消请求已提交；最终状态由后续 `wait` 或 `status` 查询。

### `fork`

从指定 session 创建独立的新 session，可用 entryId 指定历史分支点，成功返回新 sessionId。

```ts
{ action: "fork"; sessionId: string; entryId?: string }
// output
{ sessionId: string }
```

空字符串 `entryId` 非法。fork 不会自动提交新消息。

## 未开放的 `list`

`list` 是未来计划，当前不在输入 schema、工具描述或执行分发中。worker 的内部 session 枚举能力保留给已有内部调用者，不能通过 `SubAgent` 调用。
