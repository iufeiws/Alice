# capabilities

`capabilities/` 放 LLM 可调用的工具和 skills。它们实现具体能力，但不能控制 agent 主流程，也不能持有系统主状态。

目录：

- `tools/`: 已接入 runtime 的 Tool Plugin。
- `skills/`: skill 定义和预留分组。
