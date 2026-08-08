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
- 按账户隔离的唯一联系人配对（多账户同时在线）。

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
- `src/channels/feishu/src/pairing.ts`：按账户隔离的联系人绑定。
- `src/channels/feishu/src/policy.ts`：访问策略。

## 配置与持久化

- 多账户配置保存在 `FEISHU_ACCOUNTS`（JSON 对象，key 为账户 id），可在管理后台增删账户。
- 当前账户指针 `FEISHU_ACTIVE_ACCOUNT`（与账户配置同处）记录最后收到消息的账户，重启后恢复，用于无显式账户上下文时的账户选择。
- 每个账户各自维护唯一联系人绑定，保存到 `memory-files/indexes/feishu-paired-contacts.json`。
- 出站 `AgentOutput.target.accountId` 决定回复走哪个账户；未指定时用当前账户指针（为空用 `main` 或第一个账户），指定未配置账户会显式报错。
- 普通聊天消息保存到 conversation-hub 消息表。
- 追加式事件和调试日志不进入 LLM 上下文。

