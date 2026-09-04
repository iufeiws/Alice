# SubAgent 工具接口

`SubAgent` 是一个持久化子 Agent 工具。所有成功结果位于统一工具结果的 `output` 字段：

```ts
{ callId: string; ok: true; output: unknown }
```

## action

### `spawn`

创建新的持久化 SubAgent session 并提交第一条任务消息，立即返回 nickname，不等待任务完成。

```ts
{ action: "spawn"; message: string; timeoutSeconds?: number }
// output
{ nickname: string }
```

### `messages`

读取指定 nickname 对应 session 的 Pi 原始消息，再用 access 按 Python 索引或切片语义读取，例如 -1、:3、2:。

```ts
{ action: "messages"; nickname: string; access: string }
// output
Array<Record<string, unknown>>
```

返回 Pi JSONL 中 `type: "message"` 的 `message` 结构，不过滤 user、assistant、tool result、tool call、progress 或 thinking；图片、音频等 content part 中的二进制 `data` / `base64` 和 data URL 不会返回。`access` 参数保持原有功能，只接受单个整数或 `start:end`；索引越界会报错，切片可以返回空数组。序列化结果超过 2048 字符时，工具返回改为仅保留首尾各 1024 字符的截断文本，中间标注被省略的字符数。

### `result`

读取指定 nickname 对应 session 当前任务的结果；完成时返回最新 assistant message，运行中返回 `running`，其他终态只返回状态。

```ts
{ action: "result"; nickname: string }
// output
{ status: "running" }
  | { status: "completed"; message: { role: "assistant"; content: unknown } }
  | { status: "failed" | "interrupted" | "timed_out" | "aborted" }
```

### `send`

向指定 nickname 对应 session 提交一条新任务消息并立即返回原 nickname；需要结果时再调用 wait 或 result。

```ts
{ action: "send"; nickname: string; message: string; timeoutSeconds?: number }
// output
{ nickname: string }
```

### `status`

非阻塞查询 nickname 对应 session 的单一状态、最后更新时间和可见消息数量，状态包含 queued、running 及五种终态。

```ts
{ action: "status"; nickname: string }
// output
{ updatedAt: string; messages: number; status: "queued" | "running" | "completed" | "failed" | "interrupted" | "timed_out" | "aborted" }
```

### `wait`

等待 nickname 对应 session 当前任务结束；完成时返回最新 assistant 消息，等待结束时仍未完成则返回 running，其他终态只返回状态。

```ts
{ action: "wait"; nickname: string; timeoutSeconds?: number }
// output
{ status: "running" }
  | { status: "completed"; message: { role: "assistant"; content: unknown } }
  | { status: "failed" | "interrupted" | "timed_out" | "aborted" }
```

### `cancel`

请求取消 nickname 对应 session 当前运行或排队的任务，成功返回 cancelled，session 保持可复用。

```ts
{ action: "cancel"; nickname: string }
// output
"cancelled"
```

返回值只表示取消请求已提交；最终状态由后续 `wait` 或 `status` 查询。

### `fork`

从指定 nickname 对应 session 创建独立的新 session，可用 entryId 指定历史分支点，成功返回新 nickname。

```ts
{ action: "fork"; nickname: string; entryId?: string }
// output
{ nickname: string }
```

空字符串 `entryId` 非法。fork 不会自动提交新消息。

## 未开放的 `list`

`list` 是未来计划，当前不在输入 schema、工具描述或执行分发中。worker 的内部 session 枚举能力保留给已有内部调用者，不能通过 `SubAgent` 调用。
