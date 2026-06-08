# Feishu 源码模块

此目录包含飞书 Channel Plugin 的实现。

## 模块地图

- `index.ts`：plugin factory 与 message-runtime bridge。
- `client.ts`：飞书/Lark SDK wrapper，负责 WebSocket events 与出站消息。
- `monitor.ts`：client 上的生命周期 facade。
- `handlers/message.ts`：文本消息规范化。
- `handlers/lifecycle.ts`：reaction/read/recall 规范化。
- `renderer.ts`：`AgentOutput` 到飞书发送计划。
- `policy.ts`：飞书特定访问策略。
- `pairing.ts`：唯一绑定存储。
- `bindings.ts`：chat/thread/user 到 session id 的映射。
- `config.ts`：飞书配置辅助函数。
- `outbound.ts`：console outbound 测试发送器。
- `types.ts`：飞书插件本地类型。

## 接收接口

```ts
textMessageEventToAgentEvent(raw, bindings, accountId?): Promise<AgentEvent>
```

解析飞书文本事件内容，解析 session id，去除 mention keys，并返回标准 `AgentEvent`。

```ts
reactionEventToLifecycleEvent(raw, kind): FeishuMessageLifecycleEvent
readEventToLifecycleEvent(raw): FeishuMessageLifecycleEvent
recalledEventToLifecycleEvent(raw): FeishuMessageLifecycleEvent
```

把飞书生命周期回调解析为消息状态更新。这些更新以飞书 `message_id` 为目标，存储为调试记录并更新 Core 侧消息行，但不会成为独立 Core 消息。

```ts
createInMemoryFeishuBindingStore(): FeishuBindingStore
```

创建进程本地 session binding store。当前 binding key 格式：

```text
feishu:{dm|group}:{threadId|chatId|userId}
```

## 出站接口

```ts
renderForFeishu(output): FeishuSendPlan
```

支持 text、markdown、card、image、audio 与 file content。

```ts
createFeishuClient(config, deps): FeishuClient
```

启动飞书 WebSocket client，并通过 `client.im.v1.message.create` 发送飞书消息。

订阅的事件回调：

- `im.message.receive_v1`
- `im.message.reaction.created_v1`
- `im.message.reaction.deleted_v1`
- `im.message.message_read_v1`
- `im.message.recalled_v1`

媒体行为：

- image：`im.v1.image.create` 后发送 `msg_type=image`
- audio：`im.v1.file.create(file_type=opus)` 后发送 `msg_type=audio`
- file：`im.v1.file.create(file_type=stream)` 后发送 `msg_type=file`

## 绑定

```ts
createFeishuPairingStore(path, io): FeishuPairingStore
```

只允许绑定一个联系人。`pairFromEvent()` 接受第一个联系人，刷新同一联系人，并拒绝所有其他联系人。

```ts
isPairingCommand(event, config): boolean
```

当前命令从 `FEISHU_PAIRING_COMMAND` 读取，默认 `/pair alice`。
