---
name: initiated-behavior-managing
description: 管理和修改Alice的主动行为。
---

# 管理 Initiated Behavior
Alice的主动行为本质为一段llm提示词, 这些提示词为JSON格式, 你可以通过创建/修改/删除文件从而创建/修改/删除提示词

## 目录
当前行为配置位于该skill挂载位置的 `events/`下
每次加载会重建该目录, 可能导致之前的修改丢失

## 格式
每个直接子级 JSON 文件表示一个Initiated Behavior：

```json
{
  "meta": {
    "id": "...",
    "enabled": bool,
    "weight": int,
    "priority": int
  },
  "messages": [
    {
      "meta": {
        "title": "...",
        "enabled": bool
      },
      "role": "assistant",
      "content": "...",
      "reasoningContent":"...",
      "toolCalls":[...]
    }
  ]
}
```

- 文件名必须是 `<id>.json`，ID 只能包含字母、数字、下划线和连字符
- `role` 允许使用 `user` 或 `assistant`
- `weight` 与 `priority` 必须是有限数字。影响着Alice使用发起该行为的概率
- `messages` 为llm loop发起时拼接的信息, 即提示词的主体
- 提示词支持工具，每个调用必须持久化非空 `id`：

```json
{
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

## 递交
你的修改结果需要通过提供的脚本命令递交:
```bash
node scripts/submit-initiated-behaviors.mjs
```
