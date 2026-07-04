# Agent 主动行为

主动行为由 `src/contexts/initiative` 管理，用于把系统事件或随机触发转换成可执行行为计划。它不是隐藏 prompt 拼接机制；需要 LLM 文本时，行为读取明确的 prompt profile layer。

## 计划模型

当前核心类型是 `AgentInitiatedBehaviorPlan`：

- `id`：行为 id。
- `kind`：`event` 或 `randomized`。
- `enabled`：是否启用。
- `triggerEvent`：事件驱动行为的触发名。
- `weight`：随机触发行为的权重。
- `dryRun`：只记录不执行。
- `steps`：执行步骤。

步骤类型：

| kind | 说明 |
| --- | --- |
| `backend_effect` | 执行后端效果，例如 sleep cocoon |
| `llm_instruction` | 读取指定 prompt profile layer 并加入本次 LLM 请求 |
| `record_only` | 只记录运行结果 |

## 默认配置

默认行为定义在 `src/contexts/initiative/src/domain/initiated-behavior.ts`，默认 prompt profile 文件在 `src/contexts/initiative/behaviors/`。

当前事件驱动行为包括：

- `sleep_goodnight`
- `sleep_morning`
- `sleep_force_wake`
- `calendar_reminder`

当前随机行为类型包括：

- `ritual`
- `review`
- `story`
- `care`
- `share`
- `invite`
- `real_world_suggestion`

随机行为只有启用、非 dry run、权重大于 0 时才会进入抽样。

## 执行流程

1. MessageRuntime 或 heartbeat 产生带 `agentInitiatedTriggerEvent` 的 generated event。
2. initiative runtime 根据事件选择计划。
3. ChatAgent 检查计划可用性。
4. 先执行 backend effect。
5. 再读取 `llm_instruction` 指向的 prompt profile layers。
6. 使用统一 prompt layer 解析入口构筑消息。
7. 运行结果写入 initiated behavior run store。

主动行为的工具调用仍走统一 `ToolPlugin.execute` 路径；不得因为 requester、channel、loop kind 或工具名做二次拦截。

## 后台页面

后台主动行为配置页位于 `docs/app/admin/initiated-behaviors-config.md`。该页面负责启用、禁用、编辑行为配置和查看 run 记录；行为语义以本文件为准。

## 需要单独审阅的风险

子进程审阅发现代码中仍存在主动行为 generated event 的硬编码文本。按项目规则，后续如果要修改这类文本，必须先确认它是保留、迁移到 prompt layer，还是删除。本次 docs 重构不改代码。
