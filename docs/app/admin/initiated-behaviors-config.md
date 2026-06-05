# Admin 主动行为配置页方案

本文档定义后台管理器新增 Agent 主动行为配置界面的第一版页面方案。行为语义来源于 `docs/core/agent/initiated-behaviors.md`；本页只定义 admin 如何展示、编辑和保存配置，不改变 core 文档里的分层边界。

## 目标

- 在后台管理器主导航新增主动行为配置入口。
- 支持两类行为配置：事件驱动型和随机触发型。
- 让用户能启用、禁用、调整触发条件、查看最近触发记录。
- 保持行为语义归 Agent 层所有，admin 只管理配置和观测。
- 后续新增主动行为时，不要求重写整个页面布局。

## 主导航入口

后台管理器主导航新增：

```text
Initiated Behaviors
```

它是 Agent 行为管理页，不放在 `Agent Settings` 的左侧配置表单里。原因是主动行为同时涉及触发条件、调度、prompt 指令和运行记录，复杂度高于普通 agent 静态设置。

主导航建议顺序：

```text
Prompt
shell
Initiated Behaviors
Memory
llm session
Plugin
Usage
Tool Preview
```

如果当前实现仍使用左侧设置区和主工作区分离的结构，则左侧 `Agent Settings` 继续保留基础状态配置，主工作区新增 `Initiated Behaviors` 一等 tab。

## 行为分类

### 事件驱动型

事件驱动型行为由明确的 runtime 或系统事件触发。它们不需要随机调度，只需要配置启用状态、事件映射和执行约束。

当前候选：

| 行为 | 来源事件 | 说明 |
| --- | --- | --- |
| `sleep_goodnight` | sleep cocoon 自动晚安检查 | 说晚安并进入 sleep cocoon |
| `sleep_morning` | 睡眠状态变化后的 wake 事件 | 醒来后说早安 |
| `sleep_force_wake` | `/force_wake` | 以刚醒状态回应，不等同于早安 |

推荐配置项：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `enabled` | switch | 是否启用该行为 |
| `eventSources` | readonly/list | 该行为接受哪些规范化 `AgentEvent` |
| `promptInstruction` | textarea | 追加给本次 LLM loop 的一次性指令 |
| `toolPlan` | readonly/list | 预期可调用动作，例如 `sleep_cocoon({"action":"in"})` |
| `cooldownMinutes` | number | 防止同一行为短时间重复触发 |
| `allowedChannels` | multi-select | 允许在哪些通道主动发起 |
| `dryRun` | switch | 只记录触发，不执行 LLM/tool loop |

### 随机触发型

随机触发型行为没有单个确定外部事件，而是由调度器按概率、时间窗、上下文状态或冷却时间触发。它们应该和事件驱动型分开管理，避免把“概率调度”混进事件语义。

候选例子：

| 行为 | 触发模型 | 说明 |
| --- | --- | --- |
| `idle_check_in` | 空闲窗口 + 概率 | 用户长时间未互动后低概率问候 |
| `memory_reflection` | 时间窗 + 状态条件 | 在合适时间主动整理或回顾 |
| `topic_followup` | 上下文条件 + 冷却 | 对未结束话题做轻量追问 |

推荐配置项：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `enabled` | switch | 是否启用该行为 |
| `scheduleWindow` | time range | 可触发的本地时间段 |
| `minIdleMinutes` | number | 至少空闲多久后允许触发 |
| `probability` | slider/number | 每次调度检查触发概率 |
| `maxPerDay` | number | 每日最多触发次数 |
| `cooldownMinutes` | number | 两次触发之间的最短间隔 |
| `contextFilters` | structured list | 允许或拒绝触发的上下文条件 |
| `promptInstruction` | textarea | 触发后进入 LLM loop 的一次性指令 |
| `dryRun` | switch | 只记录候选命中，不执行 |

## 页面方案：表格 + Config 入口

第一版主界面用一张行为表格管理所有行为，类型只是表格里的一个字段。配置不在列表旁边展开详情面板，而是在每行提供 `Config` 按钮进入单个行为配置页或配置区域。

这个页面优先服务两件事：

- 快速看清所有主动行为当前是否启用、由什么触发、最近是否运行、运行是否健康。
- 从列表进入单个行为配置，不在主列表页直接编辑复杂触发条件。

```text
Initiated Behaviors

Toolbar
  [Search behavior] [Type: all v] [Status: all v] [Dry run only]

Behavior table
┌─────────┬────────┬──────────┬───────────────────┬────────────┬─────────────────┬──────────┬────────┬────────┐
│ Enabled │ Weight │ Priority │ Behavior          │ Type       │ Source/Schedule │ 15m resp │ Health │ Config │
├─────────┼────────┼──────────┼───────────────────┼────────────┼─────────────────┼──────────┼────────┼────────┤
│ on      │ -      │ high     │ sleep_goodnight   │ event      │ sleep check     │ 94%      │ ok     │ Config │
│ on      │ -      │ normal   │ sleep_morning     │ event      │ wake            │ 100%     │ ok     │ Config │
│ on      │ -      │ high     │ sleep_force_wake  │ event      │ /force_wake     │ 100%     │ ready  │ Config │
│ off     │ 0.08   │ low      │ idle_check_in     │ randomized │ idle window     │ 42%      │ off    │ Config │
│ off     │ 0.04   │ low      │ memory_reflection │ randomized │ time window     │ 61%      │ off    │ Config │
└─────────┴────────┴──────────┴───────────────────┴────────────┴─────────────────┴──────────┴────────┴────────┘

Recent runs
┌──────────────────────────────────────────────────────────────────────────────┐
│ small vertical scroll area                                                   │
│ time  behavior  type  trigger  result  respondedWithin15m  session           │
└──────────────────────────────────────────────────────────────────────────────┘

Randomized event chart, 30 minute buckets
  total randomized initiations
  responded within 15m: dark segment
  no response within 15m: light segment
```

选择这个结构不是因为它理想，而是因为其它结构不适合作为第一版：

- 卡片分组页会把每个行为做成独立卡片，信息密度低，后续行为数量增加后难以快速扫描运行状态。
- 策略编辑器太接近底层配置，会把第一版 admin 页面变成规则文件编辑器，误操作成本高。
- 主动行为的核心工作流是“查看状态 -> 进入配置 -> 看运行记录和响应统计”，主列表不应该承载复杂编辑器。

### 页面布局

页面分为四块：

| 区域 | 作用 |
| --- | --- |
| 顶部工具栏 | 搜索、类型过滤、启用状态过滤、dry-run 过滤、刷新 |
| 行为表格 | 展示所有主动行为的关键状态，是主操作入口 |
| Recent runs | 小型可上下滚动运行记录，只观察，不直接修改配置 |
| 响应统计柱状图 | 以 30 分钟为粒度展示随机事件发起和 15 分钟响应情况 |

桌面端：

- 主体顶部是行为表格。
- Recent runs 放在表格下方，是一个固定高度的小滚动区。
- 柱状图放在 Recent runs 下方，形态参考 Token Usage 的柱状图。

窄屏：

- 表格在上。
- 表格允许横向滚动。
- Recent runs 和柱状图在表格之后纵向排列。

不要使用主列表内联展开配置。点击 `Config` 后再进入单个行为配置页、配置子视图或专门配置区域。

### 表格字段

第一版表格字段：

| 字段 | 说明 |
| --- | --- |
| `Enabled` | 真实 switch 控件；第一版可先 disabled 展示 |
| `Weight` | 随机触发权重；事件触发型固定显示 `-` |
| `Priority` | 行为调度或冲突处理优先级，例如 `high`、`normal`、`low` |
| `Behavior` | 行为 id 和一句短说明 |
| `Type` | `event` 或 `randomized` |
| `Source / Schedule` | 事件来源或随机调度摘要 |
| `15m response` | 该行为触发后 15 分钟内收到用户响应的比例 |
| `Last run` | 最近一次触发时间，没有则 `never` |
| `Health` | `ok`、`planned`、`disabled`、`dry_run`、`failed` |
| `Config` | 进入该行为配置的按钮 |

可选扩展字段：

| 字段 | 说明 |
| --- | --- |
| `Cooldown` | 冷却时间摘要 |
| `Daily limit` | 随机触发型每日上限 |
| `Dry run` | 是否只记录不执行 |
| `Updated` | 配置最后更新时间 |

表格行为：

- 点击 `Config` 进入该行为配置。
- 行本身不展开详情。
- 行内 switch 只改启用状态，不打开详情；如果第一版不接功能，switch 必须 disabled。
- 表格不直接编辑 prompt、时间窗、概率等复杂字段。

### Config 页面

`Config` 按钮进入单个行为配置页或配置区域，按行为类型展示不同配置块。

Config 页不使用 modal，也不从主列表 inline 展开。它占用 `Initiated Behaviors` 主工作区，顶部提供返回入口，保存前后都留在当前行为配置页。

```text
← Initiated Behaviors

sleep_goodnight                                      event · enabled
Goodnight and enter sleep cocoon.                   [Save] [Test] [Reset]

┌──────────────────────────────────────┬──────────────────────────────────────┐
│ Type                                  │ Event                                │
│ [event v]                             │ triggerEvent                         │
│ Enabled  Cooldown  Dry run            │   sleep_cocoon.auto_goodnight_check  │
│ Allowed channels                      │                                      │
├──────────────────────────────────────┴──────────────────────────────────────┤
│ Prompt Instruction                                                           │
│ [textarea]                                                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│ Recent runs for this behavior                                                │
│ small vertical scroll area                                                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

当 `Type` 选择 `randomized` 时，右侧从 `triggerEvent` 切换为随机调度字段：

```text
┌──────────────────────────────────────┬──────────────────────────────────────┐
│ Type                                  │ Randomized                           │
│ [randomized v]                        │ Weight       0.08                    │
│ Enabled  Cooldown  Dry run            │ Priority     low                     │
│ Allowed channels                      │                                      │
└──────────────────────────────────────┴──────────────────────────────────────┘
```

布局规则：

- 顶部标题区显示行为 id、类型 badge、启用状态、短说明和操作按钮。
- 不要在右上角放 `Runtime Summary` 或独立详情摘要。
- `Prompt Instruction` 前面放 `Type` 选择行。
- `Type` 左侧是类型选择和通用控制：`enabled`、`cooldownMinutes`、`dryRun`、`allowedChannels`。
- `Type` 选择 `event` 时，右侧只展示 `triggerEvent`。
- `Type` 选择 `randomized` 时，右侧只展示 `weight` 和 `priority`。
- `Prompt Instruction` 独占一整行，避免长文本挤在右侧栏里。
- 当前行为的 Recent runs 放在 Config 页底部，是固定高度可上下滚动小区域。
- 桌面端 `Type` 行使用左右两列；窄屏按 `Type`、类型特定字段、`Prompt Instruction`、Recent runs 顺序纵向堆叠。

通用区域：

| 字段 | 控件 | 说明 |
| --- | --- | --- |
| `id` | readonly | 行为 id，不可编辑 |
| `kind` | select | `event` 或 `randomized` |
| `enabled` | switch | 是否启用 |
| `dryRun` | switch | 是否只记录不执行 |
| `cooldownMinutes` | number | 冷却时间 |
| `allowedChannels` | multi-select | 允许主动发起的通道 |
| `promptInstruction` | textarea | 一次性 LLM 指令 |

事件驱动型区域：

| 字段 | 控件 | 说明 |
| --- | --- | --- |
| `triggerEvent` | select/text | 规范化 `AgentEvent` 来源 |

随机触发型区域：

| 字段 | 控件 | 说明 |
| --- | --- | --- |
| `weight` | number | 随机触发权重 |
| `priority` | select | 调度或冲突处理优先级 |

Config 底部操作：

| 操作 | 第一版行为 |
| --- | --- |
| `Save` | 接 API 前 disabled |
| `Test Behavior` | 接 API 前 disabled |
| `Reset` | 接 API 前 disabled |

第一版如果暂时不接功能，Config 入口可以 disabled，或进入只读配置预览。所有会修改配置或触发运行的控件必须 disabled，并明确是 draft UI。

### Recent runs

Recent runs 是运行事实，不是配置表。它在主列表页下方占一个小区域，固定高度，可上下滚动。

字段：

| 字段 | 说明 |
| --- | --- |
| `Time` | 触发时间 |
| `Behavior` | 行为 id |
| `Type` | `event` 或 `randomized` |
| `Trigger` | 事件来源或调度命中原因 |
| `Result` | `completed`、`skipped`、`dry_run`、`failed` |
| `Responded within 15m` | 触发后 15 分钟内是否有用户响应 |
| `Session` | 关联 session id |
| `Error` | 失败原因，可折叠展示 |

规则：

- 不允许在 runs 表格里直接修改配置。
- 默认展示全局最近运行记录。
- 可以通过表格行或过滤器限制为某个行为，但不要因此改变配置状态。
- dry-run 也要记录，避免随机触发调试时没有证据。

### 响应统计柱状图

Recent runs 下方展示一个柱状图，形态参考 Token Usage 页面。

图表规则：

- 只统计随机触发型行为。
- 横轴精度为 30 分钟。
- 每个柱表示该 30 分钟窗口内随机事件发起总数。
- 深色段表示 15 分钟内有用户响应的数量。
- 浅色段表示 15 分钟内无用户响应的数量。
- 深色段 + 浅色段 = 该窗口随机事件发起总数。
- 图例必须明确区分 `responded within 15m` 和 `no response within 15m`。
- 图表数据来自运行记录聚合，不从配置表推导。

## 推荐页面结构

```text
Initiated Behaviors

Toolbar
  Search
  Type filter
  Status filter
  Dry-run filter
  Refresh

Behavior table
  Enabled
  Weight
  Priority
  Behavior
  Type
  Source / Schedule
  15m response
  Last run
  Health
  Config

Recent runs
  Time
  Behavior
  Type
  Trigger
  Result
  Responded within 15m
  Session

Randomized response chart
  30 minute buckets
  Randomized initiations total
  Responded within 15m
  No response within 15m

Config page
  Header
  Type row
  Event: triggerEvent
  Randomized: weight and priority
  Prompt Instruction
  Recent runs for this behavior
```

页面控件规则：

- 开关使用真实 switch 控件。
- prompt 指令使用 textarea。
- `triggerEvent` 使用 select 或短文本输入。
- `weight` 使用 number input。
- `priority` 使用 select。
- `Recent runs` 是固定高度的小滚动区，只做观察，不允许在日志表格里直接修改配置。
- 第一版不接功能时，所有会改变配置或触发运行的控件都必须 disabled。
- 主列表不做内联配置；复杂配置通过 `Config` 按钮进入。
- Config 页不使用 modal；它占用主工作区，并提供返回 `Initiated Behaviors` 的入口。

## 配置模型草案

```ts
type InitiatedBehaviorKind = "event" | "randomized";

type InitiatedBehaviorConfig = {
  id: string;
  kind: InitiatedBehaviorKind;
  enabled: boolean;
  weight?: number;
  priority?: "high" | "normal" | "low";
  triggerEvent?: string;
  promptInstruction: string;
  cooldownMinutes?: number;
  allowedChannels?: string[];
  dryRun?: boolean;
};
```

## API 草案

```text
GET  /admin/api/initiated-behaviors
PUT  /admin/api/initiated-behaviors
GET  /admin/api/initiated-behaviors/runs
POST /admin/api/initiated-behaviors/:behaviorId/test
```

响应草案：

```ts
type InitiatedBehaviorsAdminResponse = {
  behaviors: InitiatedBehaviorConfig[];
  runtime: {
    schedulerEnabled: boolean;
    lastCheckedAt?: string;
  };
  recentRuns: InitiatedBehaviorRun[];
  responseBuckets: InitiatedBehaviorResponseBucket[];
};

type InitiatedBehaviorRun = {
  id: string;
  behaviorId: string;
  kind: InitiatedBehaviorKind;
  triggeredAt: string;
  trigger: string;
  dryRun: boolean;
  result: "completed" | "skipped" | "dry_run" | "failed";
  respondedWithin15m?: boolean;
  sessionId?: string;
  error?: string;
};

type InitiatedBehaviorResponseBucket = {
  bucketStart: string;
  bucketMinutes: 30;
  randomizedInitiations: number;
  respondedWithin15m: number;
  noResponseWithin15m: number;
};
```

`test` 接口用于 admin 手动验证单个行为。事件驱动型 test 应模拟规范化 `AgentEvent`；随机触发型 test 应绕过概率，只验证条件、prompt 构造和 dry-run/执行路径。

## 存储建议

第一版可以使用 JSON 配置文件：

```text
apps/api/admin-ui/initiated-behaviors.json
```

这和当前 admin UI 配置文件习惯接近，便于快速落地。

如果随机触发型行为正式上线，运行记录建议进入 SQLite 或 append-only event log，而不是只写配置 JSON：

```text
initiated_behavior_runs
```

配置和运行记录分离：

- 配置是 admin 可编辑状态。
- 运行记录是 runtime 产生的事实。
- admin 页面只能展示或清理运行记录，不能通过修改日志改变行为配置。

## 实施顺序

1. 新增 admin 主导航 `Initiated Behaviors`。
2. 新增静态表格，表格包含 `Enabled`、`Weight`、`Priority`、`Behavior`、`Type`、`Source / Schedule`、`15m response`、`Last run`、`Health`、`Config`。
3. 表格先展示 core 文档已有的三个事件驱动型 sleep 行为。
4. 事件触发型的 `Weight` 固定显示 `-`。
5. 随机触发型先以 `planned` / `disabled` 示例行展示，不接入调度器。
6. `Config` 按钮第一版可以 disabled，或进入只读配置预览。
7. 新增 Config 页静态布局：Header、Type row、事件型 `triggerEvent`、随机型 `weight` / `priority`、Prompt Instruction、当前行为 Recent runs。
8. 增加固定高度、可上下滚动的 Recent runs 小区域。
9. 增加 30 分钟粒度柱状图，展示随机事件发起总数、15 分钟响应数和 15 分钟无响应数。
10. 接入 `GET /admin/api/initiated-behaviors` 后，把静态数据替换为真实配置和聚合数据。
11. 接入保存 API 后，再开放 `enabled`、`weight`、`priority`、`cooldownMinutes`、`dryRun` 等编辑。
12. 增加 `Recent runs` 观测接口。
13. 等随机调度器设计完成后，再评估是否增加更多随机触发字段。

## 开放问题

- 主动行为配置应归 `apps/api` 的 admin 配置文件，还是归 `core/agent` 包提供默认 schema 后由 admin 保存覆盖？
- `promptInstruction` 是否允许完全由 admin 编辑，还是只能编辑少量变量和模板片段？
- 随机触发型是否需要全局 master switch，防止所有随机行为一次性禁用？
- `allowedChannels` 应该使用 channel 类型、具体 session，还是 plugin/account/channel 三级目标？
- dry-run 结果是否需要写入和真实触发同一张 runs 表？
