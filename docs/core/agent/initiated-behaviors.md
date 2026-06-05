# Agent 主动行为事件

本文档定义 Agent 主动行为事件的边界。它们不是聊天触发器，而是系统或运行时产生了一个事件，要求 agent 主动执行一段行为。

主动行为可以表现为发消息、调用工具、进入状态，或这些动作的组合。当前第一批行为是 sleep cocoon 相关的晚安、早安、强制唤醒。

## 当前行为

- `sleep_goodnight`：agent 感到困了，向用户说晚安，并调用 `sleep_cocoon({"action":"in"})` 入睡。
- `sleep_morning`：agent 醒来后向用户说早安。
- `sleep_force_wake`：用户强制唤醒 agent 后，agent 以刚醒的状态回应；它不是早安事件。

## 分层边界

- API / MessageRuntime：只负责产生和派发规范化 `AgentEvent`。
- Agent 层：负责识别 `AgentEvent` 中对应的主动行为语义。
- Agent 行为模块：负责把行为转换为一次性 LLM 指令或后续动作计划。
- Chat loop：只执行已经构造好的 LLM/tool loop，不拥有行为语义。
- Shell：不参与该设计。

## 事件来源

- 睡眠状态变化后的 wake 事件。
- sleep cocoon 自动晚安检查。
- `/force_wake` 触发的强制唤醒事件。

后续可以扩展到其它 agent 主动行为，但新增前必须先写清楚行为语义、触发来源和分层边界。

## 后续代码目标

- 新增 `core/agent/src/initiated-behaviors.ts`。
- 定义 `AgentInitiatedBehavior`。
- 从 `AgentEvent` 解析主动行为。
- 将主动行为转换为一次性 prompt message。
- 从 `chat-loop.ts` 移除相关语义。

## 当前约束

- 这一步只写文档，不修改运行时代码。
- 现有代码里的 raw flag 名称暂不改。
- 后续实现时再把 `chat-loop.ts` 中已有的 trigger 逻辑迁移到 agent 主动行为模块。
