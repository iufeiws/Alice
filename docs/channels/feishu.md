# 飞书 Channel

飞书 channel 当前实现位于 `src/channels/feishu`。它负责飞书 WebSocket 事件、配对策略、入站规范化、生命周期事件、媒体下载/上传和出站发送。

## 入站

飞书文本消息会转换为统一 `AgentEvent`，写入 conversation-hub 后由 MessageRuntime 决定是否触发 Chat loop。

当前支持：

- 文本消息入站。
- 语音消息下载并经 ASR 转成 `message.audio`。
- reaction/read/recall 生命周期事件。
- 近期消息去重。
- DM/群聊访问策略。
- 唯一联系人配对。

生命周期事件只更新已有消息状态，不作为独立 Core 消息。

## 出站

飞书发送通过统一 `AgentOutput` 渲染为发送计划。

当前支持：

- text
- markdown
- card
- image
- audio
- file

图片、音频和文件会先调用飞书上传接口，再发送对应消息类型。

## 管理接口

飞书运行时由后台插件接口控制，包括状态、启动、停止、配对和测试发送。`start()` / `stop()` 必须保持幂等，不能创建重复 WebSocket client。

## 源码地图

- `src/channels/feishu/src/index.ts`：plugin factory 和 message-runtime bridge。
- `src/channels/feishu/src/client.ts`：Lark SDK wrapper、WebSocket events 和出站发送。
- `src/channels/feishu/src/monitor.ts`：生命周期 facade。
- `src/channels/feishu/src/handlers/message.ts`：文本消息规范化。
- `src/channels/feishu/src/handlers/lifecycle.ts`：生命周期事件规范化。
- `src/channels/feishu/src/renderer.ts`：`AgentOutput` 到飞书发送计划。
- `src/channels/feishu/src/pairing.ts`：唯一联系人绑定。
- `src/channels/feishu/src/policy.ts`：访问策略。

## 配置与持久化

- 唯一联系人绑定保存到 `memory-files/indexes/feishu-paired-contacts.json`。
- 普通聊天消息保存到 conversation-hub 消息表。
- 追加式事件和调试日志不进入 LLM 上下文。

