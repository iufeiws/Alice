# Admin 主动行为配置页方案

本文档定义后台管理器新增 Agent 主动行为配置界面的第一版页面方案。行为语义来源于 `docs/core/agent/initiated-behaviors.md`；本页只定义 admin 如何展示、编辑和保存配置，不改变 core 文档里的分层边界。

## 目标

- 在后台管理器主导航新增主动行为配置入口。
- 支持两类行为配置：事件驱动型和随机触发型。
- 让用户能启用、禁用、调整触发条件、查看最近触发记录。
- 让用户能编辑 layer-based prompt profile，而不是单条 prompt textarea。
- 让用户能看到行为 steps，尤其是 `sleep_goodnight` 的后台 `sleep_cocoon action=in` effect。
- 让用户能看到 runtime availability；如果主 prompt profile 隐藏了 backend effect 依赖的 tool，行为显示为 unavailable。
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
| `triggerEvent` | select/text | 该行为匹配的规范化事件 |
| `steps` | readonly/structured list | 行为计划步骤，例如 backend effect、LLM instruction、record only |
| `promptLayers` | layer editor | 参考主 prompt 的 `layers[]` 编辑器 |
| `dryRun` | switch | 只记录触发，不执行 LLM/tool loop |

### 随机触发型

随机触发型行为没有单个确定外部事件。当前 admin 只保留配置展示，不定义运行时触发器，也不把它挂到 heartbeat 或固定时间点。

候选例子：

| 行为 | 触发模型 | 说明 |
| --- | --- | --- |
| `idle_check_in` | 未接入 | 用户长时间未互动后低概率问候 |
| `memory_reflection` | 未接入 | 在合适时间主动整理或回顾 |
| `topic_followup` | 未接入 | 对未结束话题做轻量追问 |

推荐配置项：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `enabled` | switch | 是否启用该行为 |
| `weight` | number | 后续触发模型可能使用的权重，当前只展示 |
| `priority` | number | 后续冲突处理可能使用的整数优先级，当前只展示 |
| `promptLayers` | layer editor | 触发后进入 LLM loop 的 layer-based prompt |
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
│ on      │ -      │ -        │ sleep_goodnight   │ event      │ sleep check     │ 94%      │ ok     │ Config │
│ on      │ -      │ -        │ sleep_morning     │ event      │ wake            │ 100%     │ ok     │ Config │
│ on      │ -      │ -        │ sleep_force_wake  │ event      │ /force_wake     │ 100%     │ ready  │ Config │
│ off     │ 0.08   │ 0        │ idle_check_in     │ randomized │ idle window     │ 42%      │ off    │ Config │
│ off     │ 0.04   │ 0        │ memory_reflection │ randomized │ time window     │ 61%      │ off    │ Config │
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
| `Enabled` | 真实 switch 控件；切换后保存 enabled override |
| `Weight` | 随机触发权重；事件触发型固定显示 `-` |
| `Priority` | 随机触发配置优先级，整数；事件触发型固定显示 `-` |
| `Behavior` | 行为 id |
| `Type` | `event` 或 `randomized` |
| `Source / Schedule` | 事件来源；随机触发型当前显示 `randomized` |
| `15m response` | 该行为触发后 15 分钟内收到用户响应的比例 |
| `Last run` | 最近一次触发时间，没有则 `never` |
| `Health` | `ok`、`planned`、`disabled`、`dry_run`、`failed`、`unavailable` |
| `Config` | 进入该行为配置的按钮 |

表格行为：

- 点击 `Config` 进入该行为配置。
- 行本身不展开详情。
- 行内 switch 只改启用状态，不打开详情。
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
│                                      │   sleep_cocoon.auto_goodnight_check  │
├──────────────────────────────────────┴──────────────────────────────────────┤
│ Steps                                                                        │
│ backend_effect  sleep_cocoon  {"action":"in"}                                │
│ llm_instruction core/prompt/initiated-behaviors/sleep_goodnight.json         │
├──────────────────────────────────────────────────────────────────────────────┤
│ Prompt Layers                                                                │
│ [layer list: enabled, role, title, order]                                     │
│ [selected layer content editor]                                               │
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
│                                      │ Priority     0                       │
└──────────────────────────────────────┴──────────────────────────────────────┘
```

布局规则：

- 顶部标题区显示行为 id、类型 badge、启用状态、短说明和操作按钮。
- 不要在右上角放 `Runtime Summary` 或独立详情摘要。
- `Prompt Layers` 前面放 `Type` 选择行和 `Steps` 区。
- `Type` 左侧只放类型选择。
- `Type` 选择 `event` 时，右侧只展示 `triggerEvent`。
- `Type` 选择 `randomized` 时，右侧只展示 `weight` 和 `priority`。
- `Steps` 展示行为计划的实际执行步骤；`sleep_goodnight` 必须展示 backend effect `sleep_cocoon action=in`。
- `Steps` 同时展示 runtime dependency status；如果 `sleep_cocoon` 被主 prompt profile 隐藏，显示 `tool_hidden:sleep_cocoon`，并且 Health 为 `unavailable`。
- `Prompt Layers` 使用和主 Prompt 页一致的 layer-based 编辑思路：layer list + selected layer content editor。
- prompt layer 只负责 LLM 指令；后台实际效果必须保留在 `Steps`，不能被 prompt 文本替代。
- 当前行为的 Recent runs 放在 Config 页底部，是固定高度可上下滚动小区域。
- 桌面端 `Type` 行使用左右两列；窄屏按 `Type`、类型特定字段、`Steps`、`Prompt Layers`、Recent runs 顺序纵向堆叠。

通用区域：

| 字段 | 控件 | 说明 |
| --- | --- | --- |
| `id` | readonly | 行为 id，不可编辑 |
| `kind` | select | `event` 或 `randomized` |
| `steps` | structured list | 行为计划步骤 |
| `promptLayers` | layer editor | layer-based LLM 指令 |

事件驱动型区域：

| 字段 | 控件 | 说明 |
| --- | --- | --- |
| `triggerEvent` | select/text | 规范化 `AgentEvent` 来源 |

随机触发型区域：

| 字段 | 控件 | 说明 |
| --- | --- | --- |
| `weight` | number | 随机触发权重 |
| `priority` | number | 调度或冲突处理优先级 |

### Prompt Layers 编辑器

行为 prompt 的编辑器参考当前主 Prompt 页的 layer 模型，不提供单独的 `promptInstruction` textarea。

每个行为 prompt profile 存在 `core/prompt/initiated-behaviors/{behavior_id}.json`，结构为：

```ts
type InitiatedBehaviorPromptProfile = {
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

UI 结构：

```text
Prompt Layers
[Add Layer] [Add Tool Request]

▾ 晚安表达 [user]
  Title    [晚安表达]
  Role     [user v]
  Enabled  [x]
  Content  [textarea]
  [Up] [Down] [Delete]

▾ fake check_chat [tool_request]
  Title           [fake check_chat]
  Role            [tool_request v]
  Enabled         [x]
  Tool Name       [check_chat v]
  Tool Call ID    [call_check]
  Tool Arguments  [textarea]
  Thinking / Assistant Tool Call Content [textarea]
  [Up] [Down] [Delete]
```

规则：

- Prompt Layers 编辑形态照主 Prompt 页：每个 layer 是一个可展开的 details/card，不使用左侧列表加右侧编辑器。
- layer 按 `order` 排序展示。
- `enabled=false` 的 layer 不进入 LLM messages。
- `role` 只允许 `user`、`assistant`、`tool_request`；这里不能选择 `system`，避免主动行为 prompt 破坏主 prompt prefix。
- `tool_request` layer 必须展示并保存 `toolName`、`toolCallId`、`toolArguments`、`thinking`，不能降级成普通文本或隐藏 fake tool。
- Config 页必须显示 enabled/order 后组装出的 preview messages，包括 `content`、`reasoning_content`、`tool_calls`。
- 保存 prompt layers 只修改对应 `core/prompt/initiated-behaviors/{behavior_id}.json`。
- 删除或修改 prompt layer 不能删除 `steps` 中的 backend effect。
- `sleep_goodnight` 的后台入睡效果显示在 `Steps`，prompt layers 只表达晚安话术。

### Steps 展示

Steps 是行为语义的一部分，admin 可以展示并在未来提供受控编辑，但不能让普通 prompt 编辑覆盖它。

第一版 Config 页至少展示：

| 字段 | 说明 |
| --- | --- |
| `kind` | `backend_effect`、`llm_instruction`、`record_only` |
| `effect` | backend effect 名称，例如 `sleep_cocoon` |
| `arguments` | backend effect 参数 |
| `promptProfilePath` | LLM instruction 使用的 prompt profile 路径 |

`sleep_goodnight` 示例：

```text
backend_effect   sleep_cocoon   {"action":"in"}
llm_instruction  core/prompt/initiated-behaviors/sleep_goodnight.json
```

Config 底部操作：

| 操作 | 行为 |
| --- | --- |
| `Save` | 保存 plan override 和 prompt layers |
| `Reset` | 丢弃未保存修改并重新加载当前行为 |

不放没有接入的假按钮。后续新增 `Test Behavior` 前必须先接真实 API。

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
- dry-run 也要记录，避免手动测试时没有证据。

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
  Steps
  Prompt Layers
  Recent runs for this behavior
```

页面控件规则：

- 开关使用真实 switch 控件。
- `triggerEvent` 使用 select 或短文本输入。
- `weight` 使用 number input。
- `priority` 使用 number input。
- prompt 使用 layer-based editor，不使用单独 prompt textarea。
- steps 使用 structured list 展示，不能被 prompt editor 覆盖。
- `Recent runs` 是固定高度的小滚动区，只做观察，不允许在日志表格里直接修改配置。
- `kind`、`triggerEvent`、`weight`、`priority`、prompt layers 都必须是真实可编辑控件。
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
  priority?: number;
  triggerEvent?: string;
  promptProfilePath: string;
  steps: InitiatedBehaviorStep[];
};

type InitiatedBehaviorStep =
  | { kind: "backend_effect"; effect: "sleep_cocoon"; arguments: Record<string, unknown> }
  | { kind: "llm_instruction"; promptProfilePath: string }
  | { kind: "record_only"; reason: string };
```

## API 草案

```text
GET  /admin/api/initiated-behaviors
PATCH /admin/api/initiated-behaviors/:behaviorId
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

`test` 接口用于 admin 手动验证单个行为。事件驱动型 test 应模拟规范化 `AgentEvent`；随机触发型当前没有自动触发，只验证 prompt 构造和 dry-run/执行路径。

## 存储

行为配置后续可以使用 JSON 配置文件：

```text
apps/api/admin-ui/initiated-behaviors.json
```

这和当前 admin UI 配置文件习惯接近，便于快速落地；运行记录不写入配置文件。

运行记录使用 SQLite，表名：

```text
initiated_behavior_runs
```

配置和运行记录分离：

- 配置是 admin 可编辑状态。
- 运行记录是 runtime 产生的事实。
- admin 页面只能展示或清理运行记录，不能通过修改日志改变行为配置。

## 实施顺序

1. 新增 admin 主导航 `Initiated Behaviors`。
2. 新增真实表格，表格包含 `Enabled`、`Weight`、`Priority`、`Behavior`、`Type`、`Source / Schedule`、`15m response`、`Last run`、`Health`、`Config`。
3. 表格读取真实 API 返回的行为计划。
4. 事件触发型的 `Weight` 固定显示 `-`。
5. 随机触发型先以 `planned` / `disabled` 示例行展示，不接入调度器。
6. `Config` 按钮进入真实配置页。
7. 新增 Config 页：Header、Type row、事件型 `triggerEvent`、随机型 `weight` / `priority`、Steps、Prompt Layers、当前行为 Recent runs。
8. 增加固定高度、可上下滚动的 Recent runs 小区域。
9. 增加 30 分钟粒度柱状图，展示随机事件发起总数、15 分钟响应数和 15 分钟无响应数。
10. `GET /admin/api/initiated-behaviors` 返回真实配置和聚合数据。
11. 保存 API 开放 `enabled`、`kind`、`triggerEvent`、`weight`、`priority`、prompt layers 编辑。
12. 增加 `Recent runs` 观测接口。
13. 随机触发器需要重新设计后再接入；当前不挂 heartbeat 或固定时间点。

## 开放问题

- 主动行为配置应归 `apps/api` 的 admin 配置文件，还是归 `core/agent` 包提供默认 schema 后由 admin 保存覆盖？
- Steps 是否允许 admin 编辑，还是第一版只读展示？
- 随机触发型是否需要全局 master switch，防止所有随机行为一次性禁用？
- dry-run 结果是否需要写入和真实触发同一张 runs 表？
