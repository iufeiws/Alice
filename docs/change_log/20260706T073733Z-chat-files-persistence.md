# 2026-07-06 入站图片与文件落盘

## 背景

用户通过渠道发送图片或文件时，需要在本地保存原始资源，并让后续 Agent / sandbox 能通过稳定路径读取。路径约定为：

- 宿主机：`/home/yf/Alice/assets/chat_files/YYYY-MM/`
- 项目相对路径：`assets/chat_files/YYYY-MM/<messageId>-<filename>`
- sandbox 绝对路径：`/assets/chat_files/YYYY-MM/<messageId>-<filename>`

本次遵守统一入栈边界：渠道只负责把消息标准化为 `AgentEvent` 和渠道资源引用，落盘路径、文件名和 `messages` 写入由 `message-runtime` 统一处理。

## 变更内容

- 扩展 `AgentPayload`：
  - `image` / `file` 入站 payload 支持 `resource` 引用。
  - 落盘后仍使用 `assetId` 表示项目相对路径。
- 飞书入站消息标准化：
  - `image` 消息从 `image_key` 生成 `message.image` 事件。
  - `file` 消息从 `file_key` 生成 `message.file` 事件。
  - 飞书 channel 仅提供 `downloadInboundAttachment` 能力，不决定保存目录。
- `message-runtime` 统一落盘：
  - 对带 `resource` 的 `image` / `file` 生成 `assets/chat_files/YYYY-MM/<messageId>-<filename>`。
  - 先下载资源到本地文件，再写入 `messages`。
  - `messages.content_type` 写 `image` 或 `file`。
  - `messages.content_text` 和 `content_json.assetId` 写项目相对路径。
- bash sandbox 默认只读挂载：
  - 宿主机 `assets` 映射到容器 `/assets`。
  - 因此 `assets/chat_files/...` 在 sandbox 内对应 `/assets/chat_files/...`。

## 兼容性

- 不修改 `messages` schema。
- 不修改 Core / Memorize / prompt preview / prompt layer 顺序。
- 不新增隐藏 prompt。
- 普通文本和音频消息保持原有同步入栈行为。
- 当前实际资源下载能力接入飞书；其它渠道后续只需提供同样的下载能力即可复用 `message-runtime` 落盘路径。

## 验证

已执行：

```bash
npm run typecheck
node --import tsx --test tests/contexts/conversation-hub/message-runtime.test.ts tests/channels/feishu/feishu-dedupe-audio.test.ts
```

结果：

- TypeScript 类型检查通过。
- message-runtime 入站附件落盘测试通过。
- 飞书音频入站既有测试通过。
