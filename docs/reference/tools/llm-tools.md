# LLM 工具参考

本文档列出当前常用 LLM 可见工具名。旧 `check_chat`、`send_chat`、`wait_chat` 不是当前默认工具名。

## Chat

`Chat` 是聊天工具：

- `action=poll`：读取 conversation-hub 聊天上下文。
- `action=send`：发送文本、Markdown、图片或语音。

发送类型：

| type | 说明 |
| --- | --- |
| `message` | 普通文本 |
| `markdown` | Markdown |
| `image` | 已有 asset |
| `voice` | 先 TTS 合成再发送语音 |

## Yield

`Yield` 是等待控制工具，承载 `finish_and_wait` 语义。模型调用后当前 loop 让出，后续由 heartbeat 恢复并补齐聊天轮询结果。LLM 可见三种 action：

- `new`：清空当前 LLM 对话上下文，并在同一 loop 开启新一轮。
- `await`：固定等待 15 分钟；有新消息提前返回，超时无消息则直接结束会话。
- `finish`：直接结束，清空当前 LLM 会话。

执行层仍保留未暴露给 LLM 的 `schedule` action，用于定时恢复。

`schedule` 连续调用（上一个已完成工具也是 `Yield`）且当前没有运行中的 subagent 后台任务时会报错，防止模型空转。

## Bookcase

`Bookcase` 管理书架抽取和抽签能力，源码位于 `src/capabilities/tools/bookcase`。

## Wardrobe

`Wardrobe` 管理衣柜/外观记录，源码位于 `src/capabilities/tools/shell`。

## Selfie

`Selfie` 生成或发送自拍相关图片，源码位于 `src/capabilities/tools/photo`。

## SleepCocoon

`SleepCocoon` 控制睡眠茧状态，详见 `docs/reference/tools/sleep-cocoon.md`。
