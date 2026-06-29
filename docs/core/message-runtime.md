# MessageRuntime

`MessageRuntime` 是 LLM 读取和写入所有聊天平台信息的聚合入口。平台插件如何监听、轮询、验签、解密、去重属于平台插件内部职责；Core 只规定平台插件把规范化消息交给 `MessageRuntime`，以及出站消息通过哪个通用出口返回平台。

## 边界

- 平台插件：负责平台私有接收和发送实现，但必须把入站消息转换为统一的 `AgentEvent`，把消息生命周期转换为统一的 lifecycle event，并实现统一的 `ChannelPlugin.send(output)`。
- 消息运行时：`apps/api/src/message-runtime.ts` 是 Core 侧聊天消息入口，负责写入 `messages` / `message_logs`、去抖、恢复 pending 会话、调用 `ChatAgent`、落库 outbound 并驱动发送。
- Chat LLM 工具入口：`tools/messaging/src/index.ts` 向 LLM 暴露 `check_chat`、`send_chat`；`finish_and_wait` 由独立 control tool plugin 暴露。TTS 实现已经抽离到 `plugins/tts`，messaging 只调用注入的 `VoiceSynthesizer`。
- 持久化入口：`packages/storage/src/sqlite-store.ts` 的 `messages` 表保存当前聊天状态，`message_logs` 保存追加式事件和调试记录。

## 当前通用接口

当前代码已经使用统一类型，但还没有独立命名的 `ChatMessagesIngress` 接口。实际接入方式是 API 进程给每个平台插件注入回调：

```ts
type CurrentPlatformIngress = {
  onEvent(event: AgentEvent): Promise<void>;
  onLifecycleEvent?(event: MessageLifecycleEventWithoutPlugin): Promise<void>;
};
```

API 层把这些回调转发到 `MessageRuntime`：

```ts
async onEvent(event) {
  messageRuntime.ingestEvent(event);
}

async onLifecycleEvent(event) {
  messageRuntime.ingestLifecycle({ plugin, ...event });
}
```

待实现：把上述回调抽成显式公共接口，例如：

```ts
export type ChatMessagesIngress = {
  ingestEvent(event: AgentEvent): Promise<void> | void;
  ingestLifecycle(event: MessageLifecycleEvent): Promise<void> | void;
};
```

待实现：平台插件依赖应统一改为注入 `chatMessages: ChatMessagesIngress`，而不是各自声明 `onEvent` / `onLifecycleEvent`。

## 入站写入契约

平台插件不得直接写 `messages` 或 `message_logs`。平台插件只负责构造规范化事件，然后调用通用入口：

1. 普通聊天消息调用 `chatMessages.ingestEvent(event)`。当前实现为 `messageRuntime.ingestEvent(event)`。
2. read、recall、reaction 等消息状态事件调用 `chatMessages.ingestLifecycle(event)`。当前飞书已接入；微信 lifecycle 待实现。
3. `ChatMessagesIngress` 负责写入持久化表、决定是否触发 Core、标记处理状态。

这样可以保证所有平台共享同一套去抖、pending 恢复、LLM 上下文读取、出站落库和管理后台展示逻辑。

## `AgentEvent` 要求

平台插件传入的 `AgentEvent` 必须满足：

- `source.plugin`：平台 id，例如 `feishu`、`wechat` 或新增平台 id。
- `source.accountId`：多账号平台的账号 id；无多账号时可省略或使用 `main`。
- `source.channelId`：平台会话、群、频道或可发送目标 id。
- `source.userId`：发送者或 DM 目标用户 id。
- `source.rawMessageId`：平台原始 message id。用于 upsert 去重、回执、撤回、reaction 更新；平台没有 message id 时必须给出可稳定去重的替代 id。
- `session.scope`：`dm`、`group`、`topic`、`admin` 或 `desktop`。
- `session.sessionId`：Core 侧稳定会话 id。同一个聊天上下文必须始终映射到同一个 id。
- `session.threadId`：平台支持 thread/topic 时填写。
- `type`：与 payload 对应的事件类型，例如 `message.text`。
- `payload`：统一内容，支持 `text`、`markdown`、`image`、`audio`、`file`、`link`、`card_action`。
- `meta.receivedAt`：本地时区时间。
- `meta.receivedAtUtc`：UTC 时间，建议必填。
- `meta.replyTo`：回复目标 message id，通常等于平台原始 message id。
- `meta.quotedMessage`：引用消息摘要；如果平台支持引用，应在这里提供。
- `meta.raw`：原始平台事件，供调试和后台查看。

待实现：为 `AgentEvent` 增加运行时 schema 校验，入口拒绝缺失 `plugin`、`sessionId`、`payload`、`receivedAt` 的事件。

## 入站类型矩阵

语音类型统一指同一种消息语义。代码层当前有两个命名入口：入站和最终出站 `AgentPayload.kind` / `AgentOutput.content.kind` 使用 `audio`；LLM 调用 `send_chat` 时的工具参数使用 `voice`。文档中统一标注为“语音”，并在表里保留当前代码字段名。

| 入站 payload kind | event type | Core 类型定义 | Runtime 写入 | 飞书插件入站 | 微信插件入站 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| `text` | `message.text` | 已实现 | 已实现；等待 Core 处理 | 已实现 | 已实现 | 可用 |
| `markdown` | `message.markdown` | 已实现 | 已实现；当前非文本默认不触发 Core | 待实现 | 待实现 | Core 可存，平台接入待实现 |
| `image` | `message.image` | 已实现 | 已实现；当前非文本默认不触发 Core | 待实现 | 待实现 | Core 可存，平台接入待实现 |
| `audio`（语音） | `message.audio` | 已实现 | 已实现；带 `transcript` 时等待 Core 处理 | 待实现 | 待实现 | Core 可存，可按语音文本触发 |
| `file` | `message.file` | 已实现 | 已实现；当前非文本默认不触发 Core | 待实现 | 待实现 | Core 可存，平台接入待实现 |
| `link` | `message.link` | 已实现 | 已实现；当前非文本默认不触发 Core | 待实现 | 待实现 | Core 可存，平台接入待实现 |
| `card_action` | `message.card_action` | 已实现 | 已实现；当前非文本默认不触发 Core | 待实现 | 待实现 | Core 可存，平台接入待实现 |

当前 Runtime 的行为是：`payload.kind === "text"` 或 `payload.kind === "audio"` 且 `transcript` 非空的入站消息会留下空的 `coreProcessedAt` 并进入 pending Core 处理；其它入站类型会写入 `messages`，但默认直接标记为已处理。待实现：为图片、无 transcript 语音、文件、链接和卡片动作定义是否触发 Core、是否需要 ASR/OCR/文件摘要、以及这些摘要进入 `contentText` / `contentJson` 的规则。

## Lifecycle Event 要求

生命周期事件是对已有 `messages` 行的状态更新，不应单独触发 LLM。

当前支持：

- `message.read`
- `message.recalled`
- `reaction.created`
- `reaction.deleted`

事件必须包含：

- `kind`
- `plugin`
- `externalMessageId`
- `conversationId`，如果平台能提供。
- `actorId`，如果平台能提供。
- `emoji`，reaction 事件必填。
- `occurredAt`
- `occurredAtUtc`，建议必填。
- `externalEventId`，如果平台能提供，用于事件日志去重。
- `raw`，原始平台事件。

`MessageRuntime.ingestLifecycle()` 会写入 `message_logs`，然后按 `plugin + externalMessageId` 更新 `messages` 的 read、recall 或 reaction 字段。

待实现：将 `MessageLifecycleEvent` 从 `apps/api/src/message-runtime.ts` 移到共享 package，供所有平台插件直接引用。

## Runtime 入站处理

`MessageRuntime.ingestEvent()` 是所有平台普通入站消息的统一入口：

1. 写入一条 `message_logs`，`direction=inbound`，`status=received`。
2. 处理内部命令，例如文本 `/force_wake` 只改变 Agent 状态并清理 LLM session，不进入普通回复。
3. 调用 `store.upsertInboundMessage()` 写入或更新 `messages`。
4. 文本消息、带 `transcript` 的语音消息的 `coreProcessedAt` 留空，表示等待 Core 处理；其它消息会立即标记为已处理。
5. 记录最新事件到 `latestSessionEvents`，并把 `sessionId` 放入 pending set。

Heartbeat 会在入站去抖时间达到后处理 pending session：

1. `listUnprocessedCoreMessagesForConversation()` 取出同一会话未处理入站消息。
2. `buildAgentEventFromMessageLog()` 生成一条合成文本事件，提示 LLM 使用 messaging tools 查看聊天历史。
3. 调用 `core.handleEvent(agentEvent)`。
4. Core 输出转成 outbound message，先插入 `messages`，再由 `outputRouter.sendAll()` 发出。
5. 发送成功后 `markOutboundMessageSent()` 写入平台 message id；失败则 `markOutboundMessageFailed()`。
6. 入站 pending 消息通过 `markMessagesCoreProcessed()` 标记为已被 Core 消费。

重启后 `recoverPendingSessions()` 会从 `messages` 中恢复 `direction=inbound AND core_processed_at IS NULL AND is_read=0` 的会话继续处理。

## 统一消息模型

落库后的 `StoredConversationMessage` 是 LLM 查看聊天历史的事实来源：

- `plugin` + `conversationId` 表示平台和会话。
- `externalMessageId` 保存平台原始 message id。
- `direction` 为 `inbound` 或 `outbound`。
- `senderRole` 为 `user`、`assistant` 或 `system`。
- `contentType`、`contentText`、`contentJson` 保存可读摘要和结构化 payload。
- `status` 为 `sending`、`sent`、`send_failed`。
- `isRead`、`isRecalled`、`reactionsJson` 保存生命周期状态。
- `coreProcessedAt` / `coreBatchId` 表示入站消息是否已被 Core 消费。

## LLM 读取方式

LLM 不直接读取平台 API，而是通过 `tools/messaging` 的聊天工具读取 `messages`。

### `check_chat`

`check_chat` 返回格式化后的 `<chat-log>`：

- 未指定 `scope` 时，同一 LLM session 的首次调用使用 `today`，后续调用使用 `new`。
- `today` 默认返回最近一次 sleep cocoon 之后的消息；没有 sleep cocoon 游标时返回空。
- `todayold` 使用当天锚点后的消息。
- `recent` 返回最近 50 条。
- `new` 返回第一条未读用户消息之后的消息。
- `from_prefix` 用于 fixed prefix mode，只返回固定前缀游标后的消息。
- `range` 使用 `from` / `to` 按时间范围读取。

除 preview 模式外，`check_chat` 会把返回的入站用户消息标记为 read，并同时标记 `coreProcessedAt`，避免同一批消息反复触发 Core。

## LLM 出站方式

LLM 发送聊天消息只能通过 `send_chat`：

```json
{
  "type": "message",
  "content": "要发送的内容"
}
```

支持的 `type`：

- `message`：发送文本。
- `markdown`：发送 Markdown。
- `image`：发送 `assetId` 指向的图片。
- `voice`（语音）：把文本分段合成为语音后发送；工具内部会转换成 `AgentOutput.content.kind === "audio"`。

`send_chat.type` 和最终 `AgentOutput.content.kind` 的关系：

| `send_chat.type` | 最终出站 kind | 含义 | 备注 |
| --- | --- | --- | --- |
| `message` | `text` | 直接发送文本 | 默认按换行拆分，可由 messaging plugin 配置关闭 |
| `markdown` | `markdown` | 直接发送 Markdown | 插件不支持时会发送失败 |
| `image` | `image` | 发送已有 `assetId` 图片 | `content` 必须是 asset id |
| `voice`（语音） | `audio`（语音） | 先 TTS 合成音频，再发送音频 | 二者是同一种语音消息语义，字段名来自不同接口 |
 
共享 `AgentOutput.content.kind` 还定义了 `html`、`card`、`file`。它们不是当前 `send_chat` 暴露给 LLM 的类型，但其它工具或 Core 输出可以构造这些 kind。

`send_chat` 构造统一的 `AgentOutput`，并通过 `outputRouter.send(output)` 发给平台插件。每条发送前都会先 `insertOutboundMessage()`，初始状态为 `sending`；成功后更新为 `sent`，失败后更新为 `send_failed` 并写入失败原因。文本、Markdown、图片发送失败时会进入最多 3 次的 retry queue。

`message` 和 `voice`（语音）默认会按真实换行以及字面量 `\n` / `\r\n` 拆分为多条消息；`config/plugin/messaging/config.json` 中的 `splitMultilineSendChat=false` 会关闭拆分。`markdown`、`image` 不拆分。Feishu 的 core message 会渲染成 markdown，因此不受拆分开关影响。

`limitConsecutiveSends=true` 时，如果当前会话最近 10 条消息里没有用户入站回复，`send_chat` 会阻止继续发送；设为 `false` 会关闭该限制。

如果同一轮 LLM 响应包含 `send_chat`，ChatAgent 会把它视为当前入站事件的终止动作：只执行 `send_chat`，跳过同轮其它读取或搜索工具，也不会把发送结果再喂回下一轮 LLM。

## 出站接口契约

平台插件必须实现共享的 `ChannelPlugin`：

```ts
export interface ChannelPlugin {
  id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(output: AgentOutput): Promise<unknown>;
}
```

Core 通过 `outputRouter.register(plugin)` 注册平台，再通过 `outputRouter.send(output)` 或 `sendAll(outputs)` 按 `output.target.plugin` 路由。

平台插件的 `send(output)` 必须按统一 `AgentOutput` 解释发送目标和内容：

- `target.plugin` 必须等于插件 `id`。
- `target.accountId` 表示平台账号。
- `target.channelId` / `target.userId` 是平台发送目标。
- `target.sessionId` 对应 `messages.conversation_id`。
- `target.replyTo` 表示平台回复目标，平台支持时应使用。
- `content.kind` 决定文本、Markdown、图片、语音、文件等类型。
- 返回值如果包含平台 message id，Runtime 会写回 outbound message 的 `externalMessageId`。

待实现：定义通用发送返回类型，例如：

```ts
export type ChannelSendResult = {
  externalMessageId?: string;
  createdAtUtc?: string;
  raw?: unknown;
};
```

当前实现用 `unknown` 返回值，再由 Runtime 的 `extractSentMessageId()` / `extractSentMessageCreatedAtUtc()` 尝试提取。

## 出站支持矩阵

当前注册到 `outputRouter` 的平台插件是 `feishu` 和 `wechat`。

| AgentOutput kind | 飞书插件 | 微信插件 | 说明 |
| --- | --- | --- | --- |
| `text` | 已实现 | 已实现 | `send_chat.type=message` 会生成该类型 |
| `markdown` | 已实现 | 待实现 | 微信当前 `send()` 会抛出不支持错误 |
| `html` | 待实现 | 待实现 | 类型已定义，但当前两个平台都没有发送实现 |
| `card` | 已实现 | 待实现 | 飞书当前渲染为 Markdown 发送，不是原生卡片 |
| `image` | 已实现 | 已实现 | `send_chat.type=image` 会生成该类型 |
| `audio`（语音） | 已实现 | 已实现 | `send_chat.type=voice` 经 TTS 后会生成该类型 |
| `file` | 已实现 | 待实现 | 微信当前 `send()` 会抛出不支持错误 |

按 LLM 可见的 `send_chat.type` 看：

| `send_chat.type` | 飞书插件 | 微信插件 | 说明 |
| --- | --- | --- | --- |
| `message` | 已实现 | 已实现 | 映射到 `AgentOutput.text` |
| `markdown` | 已实现 | 待实现 | 映射到 `AgentOutput.markdown` |
| `image` | 已实现 | 已实现 | 映射到 `AgentOutput.image` |
| `voice`（语音） | 已实现 | 已实现 | 工具先合成音频，再映射到 `AgentOutput.audio`；`voice` 和 `audio` 在这里是同一语音类型的不同接口名 |

## 管理后台和记忆

- `GET /admin/api/message-logs` 展示 `messages`，即当前聊天历史状态。
- `GET /admin/api/message-event-logs` 展示 `message_logs`，即追加式事件和调试记录。
- 管理后台工具 preview 可显式选择目标平台调用 `check_chat`、`send_chat`，并保留后台消息搜索入口；request preview 禁止真正执行 `send_chat`。
- 记忆归纳从 `messages` 按时间范围读取聊天记录；不要把 `logs/` 当作 Core 聊天历史来源。

## 新平台接入要求

新增聊天平台时，平台插件只需要对接通用契约：

1. 实现 `ChannelPlugin` 并注册到 `outputRouter`。
2. 将平台普通消息转换为 `AgentEvent`，调用 `ChatMessagesIngress.ingestEvent()`；当前实现中调用注入的 `onEvent(event)`。
3. 将平台生命周期事件转换为 `MessageLifecycleEvent`，调用 `ChatMessagesIngress.ingestLifecycle()`；当前实现中调用注入的 `onLifecycleEvent(event)`，未支持的平台标注待实现。
4. 不直接写 `messages` / `message_logs`。
5. 保证 `session.sessionId` 稳定、`source.rawMessageId` 可去重、`meta.receivedAt` 可排序。
6. 发送成功后尽量返回平台 message id，便于 Runtime 回写 `externalMessageId` 并处理后续生命周期事件。
