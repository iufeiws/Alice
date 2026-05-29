# Feishu Plugin 说明

飞书/Lark 的 Channel Plugin。它负责飞书 WebSocket 连接、消息规范化、唯一用户绑定、飞书特定策略，以及出站消息渲染和发送。

## 公共入口

```ts
createFeishuPlugin(config, deps): ChannelPlugin & {
  ingestTextMessage(raw: FeishuTextMessageEvent): Promise<void>;
}
```

`deps` 包括：

- `onEvent(event)`：把规范化事件传给 AgentCore。
- `onLifecycleEvent(event)`：记录 reaction、read receipt、recall 这类消息状态更新。
- `log(level, message)`：写入系统/调试日志。
- `pairingStore`：保存唯一绑定的飞书联系人。
- `outbound`：可选测试/模拟发送器。

## 接收流程

```text
Feishu WS im.message.receive_v1
  -> createFeishuClient()
  -> createFeishuMonitor()
  -> textMessageEventToAgentEvent()
  -> pairing command 或策略检查
  -> message event log 调试记录
  -> messages 表作为 Core 上下文
  -> deps.onEvent(event)
```

入站消息目前只实现了文本规范化。

WebSocket client 也订阅消息生命周期回调：

- `im.message.reaction.created_v1`
- `im.message.reaction.deleted_v1`
- `im.message.message_read_v1`
- `im.message.recalled_v1`

这些回调不会作为独立消息暴露给 Core。它们按飞书 `message_id` 更新 Core 侧 `messages` 表中的匹配行：

- reactions 更新 `reactions_json`；
- read receipts 更新 `is_read` 与 `read_at`；
- recalls 更新 `is_recalled` 与 `recalled_at`。

每个生命周期回调也会写入追加式消息事件日志，便于调试。

## 绑定

命令：

```text
/pair alice
```

实际命令可通过 `FEISHU_PAIRING_COMMAND` 覆盖；默认是 `/pair alice`。

第一次成功绑定会成为唯一用户/联系人。绑定保存到：

```text
memory-files/indexes/feishu-paired-contacts.json
```

唯一绑定存在后，其他用户会被拒绝。

## 出站支持

`renderForFeishu(output)` 会把 `AgentOutput` 转换成 `FeishuSendPlan`。

支持的发送类型：

- `text`：飞书文本消息。
- `markdown`：带 Markdown element 的飞书 interactive card。
- `image`：上传本地路径后发送图片。
- `audio`：上传本地 opus 文件后发送音频。
- `file`：上传本地路径后发送文件。

对于媒体消息，`assetId` 当前表示本地文件路径或 `file://` 路径。

## Agent Messaging Tools 说明

AgentCore 向 LLM 暴露平台无关的聊天工具名：

- `check_chat`
  - 参数：无。
  - 同一 LLM session 中第一次调用返回全局最近 50 条消息。
  - 同一 LLM session 中后续调用返回全局第一条未读用户消息之后的上下文，并把读到的用户消息标记为已读。
  - 输出是给 LLM 的纯文本。相邻消息按类微信时间合并：小于 5 分钟间隔的消息共享一个 `[local time]` header，后面跟 `user/Alice:{content}[reaction][已撤回]` 行。
  - 没有新消息时返回 `nothing new`。
- `search_messages`
  - 参数：`content` 必填；`direction`、`limit`、`contextCount` 可选。
  - 当前按目标 plugin 搜索消息，不按具体飞书会话过滤。
- `send_chat`
  - 参数：`type: "message" | "markdown" | "image" | "voice"` 与 `content`；应先提供 `type`，再提供 `content`。
  - `message` 模式会把真实换行以及字面量 `\n`/`\r\n` 分隔内容拆成多条文本消息。
  - `voice` 模式会把真实换行以及字面量 `\n`/`\r\n` 分隔内容拆成多条语音消息，每段通过默认 TTS 后端合成为一条 opus 音频消息。
  - 拆分文本会按内容长度节流；第一次发送也会计入 LLM 调用开始后已经经过的时间。
  - 发送尝试会先占用节流窗口，再等待渠道返回，因此失败尝试也会计入打字/发送时间。失败发送会标记为 `send_failed`，并在内存 retry queue 中最多重试 3 次。
  - 对于 streaming LLM response，只有在 `type="message"` 或 `type="voice"` 出现后，`content` 里每个成功解码的真实换行或字面量 `\n` 才会立即发送；省略或较晚到达的 `type` 会等待最终 tool arguments。

## 关键函数

- `createFeishuClient(config, deps)`：封装飞书 SDK `Client` 与 `WSClient`。
- `createFeishuMonitor(config, deps)`：client 上的生命周期 facade。
- `textMessageEventToAgentEvent(raw, bindings, accountId)`：把飞书文本事件映射为 `AgentEvent`。
- `reactionEventToLifecycleEvent(raw, kind)`：把飞书 reaction 回调映射为消息状态更新。
- `readEventToLifecycleEvent(raw)`：把飞书 read 回调映射为消息状态更新。
- `recalledEventToLifecycleEvent(raw)`：把飞书 recall 回调映射为消息状态更新。
- `checkFeishuEventPolicy(config, event)`：DM/群聊策略检查。
- `createFeishuPairingStore(path, io)`：唯一绑定存储。
- `renderForFeishu(output)`：出站计划渲染器。
