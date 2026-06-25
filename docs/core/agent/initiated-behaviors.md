# Agent 主动行为实现计划

本文档定义 Agent 主动行为的下一步实现计划。主动行为不是固定的一条 user prompt，而是由系统或运行时触发后，由 Agent 层解析并生成的一组可执行行为计划。

主动行为可以包含后台实际效果、LLM 指令、记录动作和后续工具计划。prompt 只是行为计划中的一种 step，不代表行为本身。

## 目标

- 将主动行为从硬编码 prompt 迁移为可配置行为计划。
- 支持事件驱动型和随机触发型两类主动行为。
- 将行为 prompt 存到 `src/core/prompt`，并沿用当前主 prompt 的 layer-based profile 结构。
- 让 admin 能编辑行为配置和 prompt layers，但不拥有行为语义。
- 为运行记录、15 分钟响应统计和 30 分钟随机触发聚合预留实现边界。

## 行为分类

### 事件驱动型

事件驱动型行为由明确的 runtime 或系统事件触发。第一批行为仍是 sleep cocoon 相关行为：

| 行为 | 触发事件 | 目标效果 |
| --- | --- | --- |
| `sleep_goodnight` | sleep cocoon 自动晚安检查 | 后台执行入睡效果，并让 Agent 对用户说晚安 |
| `sleep_morning` | 睡眠状态变化后的 wake 事件 | 让 Agent 醒来后问候用户 |
| `sleep_force_wake` | `/force_wake` 触发的强制唤醒事件 | 让 Agent 以刚醒状态回应，不等同于普通早安 |

`sleep_goodnight` 的 `sleep_cocoon({"action":"in"})` 必须是后台实际效果，不应只写在 prompt 里等待模型自己调用工具。

如果当前主 prompt profile 隐藏了 `sleep_cocoon` tool，则依赖该 backend effect 的行为不可用。`sleep_goodnight` 在这种状态下应记录为 `skipped/unavailable`，不执行 `sleep_cocoon({"action":"in"})`，也不继续注入晚安 prompt。

### 随机触发型

随机触发型行为没有单个确定外部事件。触发入口绑定在 Agent state 的 `idle` 随机延迟到期点：当 heartbeat 发现 `idle` 的随机延迟已经到期时，先做一次随机判断，再决定是否进入普通 idle 状态 roll。普通 heartbeat、manual process-now、sleep cocoon 事件、waiting/away/sleeping 等状态转换都不触发随机事件。

随机判断依赖 `messages` 表中最近一条对话记录的时间，不读取 append-only `message_logs`。设当前时间距离最近一条 conversation message 的时长为 `t`，则：

```text
p = min(t / 4小时, 1) / 2
```

当随机数小于 `p` 时，从启用的随机事件池中按 `weight` 加权抽取一种事件，并生成一条 `system.heartbeat` 事件交给 Agent Core。命中后不再执行 idle 的普通 `waiting/away/idle` roll；主动会话结束后状态落到 `waiting`。生成事件必须包含统一事件名：

```json
{
  "agentInitiatedTriggerEvent": "randomized"
}
```

随机事件池参考主动对话发起草案：

| 行为 | 默认启用 | 权重 | 说明 |
| --- | --- | ---: | --- |
| `ritual` | 否 | 8 | 日常仪式、特殊日子或节日问候 |
| `review` | 否 | 2 | 基于未闭环话题、计划或情绪线索轻量回访 |
| `story` | 否 | 1 | 低频故事讲述 |
| `care` | 是 | 4 | 低打扰关怀型问候 |
| `share` | 否 | 2 | 与用户兴趣相关的内容分享 |
| `invite` | 否 | 2 | 邀请用户一起做轻任务或小活动 |
| `real_world_suggestion` | 否 | 2 | 饭点、休息、散步、睡前等现实世界轻量提议 |

触发前必须满足：

- 没有 pending user message 或正在处理中的 session。
- 当前没有活跃 LLM session。
- Agent 当前状态允许 heartbeat 运行。
- 存在默认 messaging target。
- `messages` 表中存在至少一条可解析时间的记录。

随机触发型配置支持：

- `enabled`
- `weight`
- `priority`
- `dryRun`
- prompt layers

## 行为计划模型

目标模型：

```ts
type AgentInitiatedBehaviorKind = "event" | "randomized";

type AgentInitiatedBehaviorPriority = number;

type AgentInitiatedBehaviorPlan = {
  id: string;
  kind: AgentInitiatedBehaviorKind;
  enabled: boolean;
  triggerEvent?: string;
  weight?: number;
  priority?: AgentInitiatedBehaviorPriority;
  dryRun?: boolean;
  promptProfilePath?: string;
  steps: AgentInitiatedBehaviorStep[];
};
```

`AgentInitiatedBehaviorPlan` 不等同于 prompt。它是 Agent 层对一次主动行为的完整执行计划。

所有主动行为事件都通过 `meta.raw.agentInitiatedTriggerEvent` 路由。事件生产方只写事件名；Agent Core 用该事件名匹配启用的 `triggerEvent`，不再读取每种事件的 boolean 标记，也不再用 `agentInitiatedBehaviorId` 做事件路由。随机主动行为统一使用 `randomized`，具体行为在 resolver 内按权重选择。

### Step 类型

第一版最小 step 集合：

```ts
type AgentInitiatedBehaviorStep =
  | {
      kind: "backend_effect";
      effect: "sleep_cocoon";
      arguments: Record<string, unknown>;
    }
  | {
      kind: "llm_instruction";
      promptProfilePath: string;
    }
  | {
      kind: "record_only";
      reason: string;
    };
```

含义：

- `backend_effect`：由后台直接执行实际效果，不依赖 LLM 自己调用工具。
- `llm_instruction`：读取 layer-based prompt profile，组装为一次性 LLM message。
- `record_only`：只记录行为命中或跳过原因，不启动实际效果或 LLM。

backend effect 仍受当前主 prompt profile 的 tool 可见性约束。隐藏某个 tool 表示模型不可使用该 tool，也表示依赖该 tool 的 backend effect 在当前运行态不可用。

## Prompt 存储

行为 prompt 存到 `src/core/prompt`。存储结构参考当前主 prompt profile，使用 layer-based profile：

```ts
type AgentInitiatedBehaviorPromptProfile = {
  layers: Array<{
    id: string;
    title: string;
    role: "user" | "assistant" | "tool_request";
    enabled: boolean;
    content: string;
    order: number;
    thinking?: string;
    toolName?: string;
    toolCallId?: string;
    toolArguments?: string;
  }>;
};
```

规则：

- 每个主动行为可以有独立 prompt profile。
- 主动行为 prompt profile 不能新增 `system` layer，避免覆盖或破坏主 prompt prefix。
- `tool_request` layer 与主 Prompt 页 fake tool layer 使用同一结构，必须在 admin Config 和 assembled preview 中显示 `tool_calls`。
- Agent 执行时按 `enabled` 和 `order` 组装 prompt messages。
- 禁用 layer 后，该 layer 不进入 LLM messages。
- prompt profile 只负责表达 LLM 指令，不负责后台实际效果。
- admin 可以编辑 prompt layers，但不能用 prompt 覆盖行为语义。

建议路径：

```text
src/core/prompt/initiated-behaviors/sleep_goodnight.json
src/core/prompt/initiated-behaviors/sleep_morning.json
src/core/prompt/initiated-behaviors/sleep_force_wake.json
src/core/prompt/initiated-behaviors/idle_check_in.json
src/core/prompt/initiated-behaviors/memory_reflection.json
src/core/prompt/initiated-behaviors/topic_followup.json
```

## Sleep 行为目标实现

### sleep_goodnight

目标行为计划：

```ts
{
  id: "sleep_goodnight",
  kind: "event",
  enabled: true,
  triggerEvent: "sleep_cocoon.auto_goodnight_check",
  promptProfilePath: "src/core/prompt/initiated-behaviors/sleep_goodnight.json",
  steps: [
    {
      kind: "backend_effect",
      effect: "sleep_cocoon",
      arguments: { action: "in" }
    },
    {
      kind: "llm_instruction",
      promptProfilePath: "src/core/prompt/initiated-behaviors/sleep_goodnight.json"
    }
  ]
}
```

实现要求：

- 后台先执行 `sleep_cocoon({"action":"in"})` 的实际效果。
- 如果主 prompt profile 隐藏了 `sleep_cocoon`，则该行为不可用，只记录 skipped/unavailable，不执行入睡，也不启动 LLM。
- prompt layers 只负责让 Agent 对用户说晚安。
- prompt 不需要要求模型调用 `sleep_cocoon` 才能产生入睡效果。

### sleep_morning

目标行为计划：

```ts
{
  id: "sleep_morning",
  kind: "event",
  enabled: true,
  triggerEvent: "sleep_cocoon.wake",
  promptProfilePath: "src/core/prompt/initiated-behaviors/sleep_morning.json",
  steps: [
    {
      kind: "llm_instruction",
      promptProfilePath: "src/core/prompt/initiated-behaviors/sleep_morning.json"
    }
  ]
}
```

### sleep_force_wake

目标行为计划：

```ts
{
  id: "sleep_force_wake",
  kind: "event",
  enabled: true,
  triggerEvent: "sleep_cocoon.force_wake",
  promptProfilePath: "src/core/prompt/initiated-behaviors/sleep_force_wake.json",
  steps: [
    {
      kind: "llm_instruction",
      promptProfilePath: "src/core/prompt/initiated-behaviors/sleep_force_wake.json"
    }
  ]
}
```

实现要求：

- 强制唤醒回应不应复用普通早安语义。
- `/force_wake` 已经由 runtime 改变 Agent 状态；该行为只负责生成刚醒状态回应。

## 随机触发型目标实现

随机触发型行为由 `MessageRuntime` 在 `idle_timer` 到期转换时判断是否生成主动事件。行为语义仍由 Agent 行为模块和 prompt profile 决定；MessageRuntime 只负责在合适的状态转换点做概率判断、抽取已启用事件并生成 runtime event。

配置示例：

```ts
{
  id: "care",
  kind: "randomized",
  enabled: true,
  weight: 4,
  priority: 0,
  dryRun: false,
  promptProfilePath: "src/core/prompt/initiated-behaviors/care.json",
  steps: [
    {
      kind: "llm_instruction",
      promptProfilePath: "src/core/prompt/initiated-behaviors/care.json"
    }
  ]
}
```

当前规则：

- 默认配置中随机触发型行为保持 disabled。
- 当前实现不提供随机选择器。
- 当前实现不在 heartbeat 或任意固定时间点生成随机行为 event。
- `weight` 和 `priority` 只作为 admin 配置展示字段保留。

## 分层边界

- API / MessageRuntime：产生事件驱动型 generated event；不拥有行为语义；只在 `idle_timer` 到期转换时按配置生成随机主动事件。
- Agent 行为模块：读取配置，匹配事件，生成 `AgentInitiatedBehaviorPlan`。
- Prompt 存储：只保存 layer-based prompt profile，不保存运行记录。
- Backend effect 执行层：执行 `sleep_cocoon` 等后台实际效果。
- Chat / LLM loop：只执行已构造好的 LLM messages，不决定主动行为语义。
- Admin：编辑配置和 prompt layers，展示运行记录和统计，不直接修改运行事实。
- Shell：不参与主动行为设计。

## Admin 对接

Admin Config 需要能表达：

- `id`
- `kind`
- `enabled`
- `triggerEvent`
- `weight`
- `priority`
- `dryRun`
- `prompt layers`
- `steps`

`sleep_goodnight` 的 Config 必须能表达：

- `triggerEvent = sleep_cocoon.auto_goodnight_check`
- `backend_effect = sleep_cocoon action=in`
- prompt layers 只负责晚安表达

保存规则：

- 保存 prompt 只修改 `src/core/prompt` 下的行为 prompt profile。
- 保存行为配置不应吞掉 backend effect。
- Recent runs 和 30 分钟图表来自 run 聚合，不从配置表推导。

## Run 记录

每次主动行为候选、跳过、dry-run、执行、失败都应写运行记录。

运行记录当前使用 SQLite 持久化，表名为 `initiated_behavior_runs`。`steps` 以 JSON 字段保存，便于 admin 展示每个 step 的执行结果。

目标模型：

```ts
type AgentInitiatedBehaviorRun = {
  id: string;
  behaviorId: string;
  kind: AgentInitiatedBehaviorKind;
  triggeredAt: string;
  triggeredAtUtc?: string;
  trigger: string;
  dryRun: boolean;
  result: "completed" | "skipped" | "dry_run" | "failed";
  sessionId?: string;
  respondedWithin15m?: boolean;
  steps: Array<{
    kind: AgentInitiatedBehaviorStep["kind"];
    result: "completed" | "skipped" | "failed";
    error?: string;
  }>;
  error?: string;
};
```

统计规则：

- `respondedWithin15m` 从行为触发后的用户响应计算。
- 时间窗口计算以 `triggeredAtUtc` 为准；`triggeredAt` 保留为运行时展示时间，避免本地时区字符串和 UTC inbound message 混算。
- 同 session 在触发后 15 分钟内收到用户 inbound message 时，`respondedWithin15m = true`。
- 超过 15 分钟仍无响应时，查询或定时维护应补齐为 `false`。
- 15 分钟响应比例从 run 记录聚合。
- 30 分钟柱状图只统计随机触发型发起数。
- 柱状图中深色段为 15 分钟内响应数，浅色段为 15 分钟内无响应数。
- 仍在 15 分钟窗口内的 pending run 只计入 total，不计入浅色段。

## 实施顺序

1. 定义 `AgentInitiatedBehaviorPlan` 和最小 step 类型。
2. 定义行为 prompt profile 文件结构，沿用主 prompt 的 layer schema。
3. 将当前三条 hardcoded sleep prompt 迁移到 `src/core/prompt/initiated-behaviors/`。
4. 将 `sleep_goodnight` 拆分为 backend effect 和晚安 prompt layers。
5. 增加行为配置读取层，先支持三条 sleep event config。
6. 保留现有 raw flag 兼容入口，并映射到新的 `triggerEvent`。
7. 增加 run 记录，记录整体行为和每个 step 的执行结果。
8. 接入随机触发型 idle 到期触发器，只在 `idle_timer` 转换时判断一次。
9. 增加 admin API：列表、Config、保存、runs、30 分钟 bucket 聚合。
10. 将 admin 静态 UI 替换为真实配置和真实 prompt layers。

## 测试计划

### Prompt layer 存储

- 行为 prompt profile 按 `enabled/order` 组装。
- 禁用某个 layer 后，该 layer 不进入 LLM messages。
- 修改 `src/core/prompt` 中行为 layer 后，下次行为执行使用新文本。

### sleep_goodnight

- 事件命中后执行 backend effect `sleep_cocoon action=in`。
- LLM 请求包含 layer-based 晚安 prompt。
- prompt 不要求模型调用 `sleep_cocoon` 也能产生入睡效果。
- backend effect 失败时 run 记录为 `failed`。

### sleep_morning / sleep_force_wake

- 分别注入对应 layer-based prompt。
- `sleep_force_wake` 不包含普通早安语义。

### 随机触发型

- 默认随机池包含 `ritual/review/story/care/share/invite/real_world_suggestion`。
- 默认只有 `care` enabled，其他类型保留配置。
- 按 `weight` 加权抽取，并跳过 disabled、dryRun 和非正权重行为。
- idle timer 到期且概率命中时生成 randomized initiated behavior event。
- 有 pending inbound、LLM busy、无默认 target、无 message 记录时不触发。

### Admin

- Config 页能编辑 prompt layers。
- 保存 prompt 只改 `src/core/prompt` 的 layer profile。
- 保存行为配置不丢失 backend effect。
- Recent runs 和 30 分钟图表来自 run 聚合。

## 当前约束

- 本文档是实现计划，不代表当前代码已经完成上述能力。
- 当前代码仍保留 hardcoded sleep prompt 和 raw flag 解析。
- `sleep_goodnight` 的后台 actual effect 是下一步目标，不是当前实现。
- 随机触发型第一版只在 idle timer 到期时判断一次，不引入每日次数上限或额外勿扰窗口。
