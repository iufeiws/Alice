# 控制命令上下文

`control-command` 负责识别和执行不应进入普通消息历史或 Chat loop 的入站控制命令。

当前命令：

- `/force_wake`：取得 MainAgent clearing 占用并清理当前 LLM session；成功后进入 `waiting`、清理睡眠茧，并触发强制唤醒事件。
- `/force_clear`：取得 MainAgent clearing 占用并清理当前 LLM session；不改变 Agent 状态、不清理睡眠茧，也不触发 wake。

非命令事件会同步返回未处理结果，避免改变普通消息的落库时序。命令执行失败或 MainAgent 正忙时，命令仍视为已消费，不会回落到普通消息路径。
