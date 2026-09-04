# MessageRuntime 消息运行时

`MessageRuntime` 是离散聊天消息的运行时入口，当前实现位于 `src/contexts/conversation-hub/src/application/ingest-channel-message.ts`。它负责把平台消息写入 conversation-hub、恢复 pending 会话、触发 ChatAgent，并通过 output router 发出回复。

## 边界

- 平台 channel 负责平台私有监听、鉴权、解密、去重和发送协议。
- MessageRuntime 负责统一入站、生命周期事件、会话 pending、出站落库和发送调度。
- LLM 通过 `Chat` 工具读取或发送聊天消息；等待当前 loop 暂停由 `Yield` 工具负责。
- 持久化消息位于 conversation-hub 的 SQLite store；追加式消息事件和调试日志不等同于 Core 聊天历史。

## 入站

平台插件把消息转换为统一 `AgentEvent` 后交给 MessageRuntime。当前 API 装配层通过回调转发，长期方向是显式注入统一 ingress 接口。

入站事件至少需要稳定提供：

- `source.plugin`
- `source.channelId`
- `source.userId`
- `source.rawMessageId`
- `session.sessionId`
- `payload.kind`
- `meta.receivedAt`

空白文本和无有效转写的语音在入站边界直接丢弃。其余真实用户入站消息都会进入 pending Core 处理，包括文本、Markdown、图片、语音、文件、链接和卡片动作。运行中同会话 Chat 会在下一个真实插入点取得这些消息；非运行状态则由 heartbeat 按统一 pending 流程发起处理。不得把尚未消费的消息预先标记为已处理。

## 生命周期事件

飞书等平台的 read、recall、reaction 事件作为已有消息的状态更新处理，不单独触发 LLM。生命周期事件写入消息事件日志，并按平台 message id 更新 conversation-hub 中的消息行。

## Pending 处理

MessageRuntime 收到可处理入站后把会话放入 pending set。Heartbeat 达到去抖条件后：

1. 读取同一会话未处理入站。
2. 构造合成 Agent event。
3. 请求 Chat loop 处理。
4. 将 Core 输出先写入 outbound message，再通过 output router 发送。
5. 成功或失败后更新 outbound 状态。
6. 标记本批入站已被 Core 消费。

重启后会从未处理入站消息恢复 pending 会话。

## LLM 工具

当前聊天工具是单一 `Chat` 工具：

- `action=poll`：读取 conversation-hub 中的聊天上下文。
- `action=send`：发送文本、Markdown、图片或语音。

当前等待工具是 `Yield`，用于 `finish_and_wait` 语义。旧 `check_chat`、`send_chat`、`wait_chat` 不是当前默认 LLM 可见工具名。

## 出站

`Chat action=send` 构造统一 `AgentOutput`，先写 outbound message，再由 output router 投递到对应 channel。

支持的常用发送类型：

| Chat type | AgentOutput kind | 说明 |
| --- | --- | --- |
| `message` | `text` | 普通文本 |
| `markdown` | `markdown` | Markdown |
| `image` | `image` | 已有 asset |
| `voice` | `audio` | 先 TTS 合成，再发送音频 |

文本、Markdown、图片发送失败会进入有限重试；语音发送依赖 TTS 与目标 channel 的音频能力。
