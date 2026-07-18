---
name: manage-random-events
description: 在 sandbox 中查看、设计、创建、修改、启停或删除 Alice 的 Random Events，并通过飞书审批提交。需要管理随机主动行为、权重或对应 messages 时使用。
---

# 管理 Random Events

## 工作目录

当前正式配置已复制到 `/skills/manage-random-events/events/`。再次加载本 skill 会用正式配置覆盖这里所有未提交修改。

每个直接子级 JSON 文件表示一个 Random Event：

```json
{
  "meta": {
    "id": "event_id",
    "enabled": false,
    "weight": 1,
    "priority": 0
  },
  "messages": [
    {
      "meta": {
        "title": "Instruction",
        "enabled": true
      },
      "role": "user",
      "name": "Cheshire Cat",
      "content": "明确的事件指令"
    }
  ]
}
```

文件名必须是 `<id>.json`，ID 只能包含字母、数字、下划线和连字符。`weight` 与 `priority` 必须是有限数字。消息顺序就是数组顺序，禁用消息使用 `message.meta.enabled: false`。

工具调用使用 assistant message 的 `toolCalls`，每个调用必须持久化非空 `id`：

```json
{
  "meta": { "title": "调用工具", "enabled": true },
  "role": "assistant",
  "content": "",
  "reasoningContent": "...",
  "toolCalls": [
    {
      "id": "call_explicit_id",
      "type": "function",
      "function": {
        "name": "Chat",
        "arguments": "{\"action\":\"poll\"}"
      }
    }
  ]
}
```

不要使用旧字段 `layers`、`order`、`tool_request`、`toolName`、`toolArguments` 或 `thinking`。

## 工作流

1. 先读取全部现有文件，避免重复 ID，并参考当前权重和 layer 风格。
2. 直接编辑文件；新增文件表示创建，删除文件表示删除。
3. 不要修改本 skill 的其他文件，不要在 event JSON 之外追加任何 prompt。
4. 完成全部修改后只运行一次：

```bash
node /skills/manage-random-events/scripts/submit-random-events.mjs
```

提交会按有差异的文件逐项等待飞书审批。`approved` 已立即生效；`rejected` 未生效；`revision_requested` 时按 comment 修改对应文件后再次运行提交脚本；`stale` 时重新加载本 skill 后重做修改。
