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

## 页面方案：表格 + 详情抽屉

第一版采用本方案。主界面用一张行为表格管理所有行为，类型只是表格里的一个字段。点击行后打开详情抽屉或右侧详情面板。

这个页面优先服务两件事：

- 快速看清所有主动行为当前是否启用、由什么触发、最近是否运行、运行是否健康。
- 选中一行后再编辑该行为的触发条件、prompt 指令、冷却时间和 dry-run 状态。

```text
Initiated Behaviors

Toolbar
  [Search behavior] [Type: all v] [Status: all v] [Dry run only]

┌──────────────────────────────────────────────────────────────┬─────────────────────────────┐
│ Behavior table                                                │ Detail panel                 │
│                                                              │                             │
│ Enabled  Behavior          Type        Source       Last run │ sleep_goodnight             │
│ on       sleep_goodnight   event       sleep check  21:43    │ event · enabled             │
│ on       sleep_morning     event       wake         08:12    │                             │
│ on       sleep_force_wake  event       /force_wake  never    │ Trigger                     │
│ off      idle_check_in     randomized  idle window  never    │   sleep cocoon auto check   │
│ off      memory_reflection randomized  time window  never    │                             │
│                                                              │ Configuration               │
│ Recent runs                                                  │   enabled                   │
│   time behavior trigger result session                       │   cooldown                  │
│                                                              │   promptInstruction         │
└──────────────────────────────────────────────────────────────┴─────────────────────────────┘
```

选择这个结构不是因为它理想，而是因为其它结构不适合作为第一版：

- 卡片分组页会把每个行为做成独立卡片，信息密度低，后续行为数量增加后难以快速扫描运行状态。
- 策略编辑器太接近底层配置，会把第一版 admin 页面变成规则文件编辑器，误操作成本高。
- 主动行为的核心工作流是“查看状态 -> 选中一行 -> 查看或编辑详情 -> 看运行记录”，表格 + 详情面板最少引入额外结构。

### 页面布局

页面分为四块：

| 区域 | 作用 |
| --- | --- |
| 顶部工具栏 | 搜索、类型过滤、启用状态过滤、dry-run 过滤、刷新 |
| 行为表格 | 展示所有主动行为的关键状态，是主操作入口 |
| 详情面板 | 展示和编辑当前选中行为的配置 |
| Recent runs | 展示最近运行记录，只观察，不直接修改配置 |

桌面端：

- 左侧或中间主体为行为表格。
- 右侧为 sticky 详情面板。
- Recent runs 放在表格下方，跟随当前筛选或当前选中行为刷新。

窄屏：

- 表格在上，详情面板在下。
- 表格允许横向滚动。
- Recent runs 放在详情面板之后。

不要使用 modal 作为主要编辑入口。详情面板可以是右侧固定面板，也可以是页面内右栏；移动端再自然堆叠。

### 表格字段

第一版表格字段：

| 字段 | 说明 |
| --- | --- |
| `Enabled` | 真实 switch 控件；第一版可先 disabled 展示 |
| `Behavior` | 行为 id 和一句短说明 |
| `Type` | `event` 或 `randomized` |
| `Source / Schedule` | 事件来源或随机调度摘要 |
| `Last run` | 最近一次触发时间，没有则 `never` |
| `Health` | `ok`、`planned`、`disabled`、`dry_run`、`failed` |

可选扩展字段：

| 字段 | 说明 |
| --- | --- |
| `Cooldown` | 冷却时间摘要 |
| `Daily limit` | 随机触发型每日上限 |
| `Dry run` | 是否只记录不执行 |
| `Updated` | 配置最后更新时间 |

表格行为：

- 点击行选中行为并更新详情面板。
- `Enter` / `Space` 也可以选中行。
- 行内 switch 只改启用状态，不打开详情；如果第一版不接功能，switch 必须 disabled。
- 表格不直接编辑 prompt、时间窗、概率等复杂字段。

### 详情面板

详情面板按行为类型展示不同配置块。

通用区域：

| 字段 | 控件 | 说明 |
| --- | --- | --- |
| `id` | readonly | 行为 id，不可编辑 |
| `kind` | readonly/badge | `event` 或 `randomized` |
| `enabled` | switch | 是否启用 |
| `dryRun` | switch | 是否只记录不执行 |
| `cooldownMinutes` | number | 冷却时间 |
| `allowedChannels` | multi-select | 允许主动发起的通道 |
| `promptInstruction` | textarea | 一次性 LLM 指令 |

事件驱动型区域：

| 字段 | 控件 | 说明 |
| --- | --- | --- |
| `eventSources` | readonly/list | 规范化 `AgentEvent` 来源 |
| `toolPlan` | readonly/list | 预期工具动作 |
| `lastEventAt` | readonly | 最近一次来源事件时间 |

随机触发型区域：

| 字段 | 控件 | 说明 |
| --- | --- | --- |
| `scheduleWindow` | time range | 可触发本地时间窗 |
| `minIdleMinutes` | number | 最短空闲时间 |
| `probability` | slider + number | 每次检查触发概率 |
| `maxPerDay` | number | 每日最多触发次数 |
| `contextFilters` | structured list | 上下文条件 |

详情面板底部操作：

| 操作 | 第一版行为 |
| --- | --- |
| `Save` | 接 API 前 disabled |
| `Test Behavior` | 接 API 前 disabled |
| `Reset` | 接 API 前 disabled |

第一版如果暂时不接功能，详情面板仍要把字段布局做对，但所有编辑型控件 disabled，并明确是 draft UI。

### Recent runs

Recent runs 是运行事实，不是配置表。

字段：

| 字段 | 说明 |
| --- | --- |
| `Time` | 触发时间 |
| `Behavior` | 行为 id |
| `Type` | `event` 或 `randomized` |
| `Trigger` | 事件来源或调度命中原因 |
| `Result` | `completed`、`skipped`、`dry_run`、`failed` |
| `Session` | 关联 session id |
| `Error` | 失败原因，可折叠展示 |

规则：

- 不允许在 runs 表格里直接修改配置。
- 如果选中某个行为，可以默认只展示该行为最近运行记录。
- 可以提供 `Show all runs` 切换回全局记录。
- dry-run 也要记录，避免随机触发调试时没有证据。

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
  Behavior
  Type
  Source / Schedule
  Last run
  Health

Detail panel
  Summary
  Trigger
  Configuration
  Prompt instruction
  Actions

Recent runs
  Time
  Behavior
  Type
  Trigger
  Result
  Session
```

页面控件规则：

- 开关使用真实 switch 控件。
- 概率使用 slider + number input 双控件。
- 时间窗使用 start/end time inputs。
- prompt 指令使用 textarea。
- `eventSources`、`lastRunAt`、`runtimeStatus` 使用 readonly 字段。
- `Recent runs` 只做观察，不允许在日志表格里直接修改配置。
- 第一版不接功能时，所有会改变配置或触发运行的控件都必须 disabled。
- 表格选中行可以本地更新详情面板，不需要 API。

## 配置模型草案

```ts
type InitiatedBehaviorKind = "event" | "randomized";

type InitiatedBehaviorConfig = {
  id: string;
  kind: InitiatedBehaviorKind;
  enabled: boolean;
  promptInstruction: string;
  cooldownMinutes?: number;
  allowedChannels?: string[];
  dryRun?: boolean;
  event?: EventDrivenBehaviorConfig;
  randomized?: RandomizedBehaviorConfig;
};

type EventDrivenBehaviorConfig = {
  eventSources: string[];
  toolPlan?: Array<{
    tool: string;
    arguments: Record<string, unknown>;
  }>;
};

type RandomizedBehaviorConfig = {
  scheduleWindow?: {
    startLocalTime: string;
    endLocalTime: string;
  };
  minIdleMinutes?: number;
  probability: number;
  maxPerDay?: number;
  contextFilters?: Array<{
    field: string;
    operator: "equals" | "not_equals" | "exists" | "missing";
    value?: unknown;
  }>;
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
};

type InitiatedBehaviorRun = {
  id: string;
  behaviorId: string;
  kind: InitiatedBehaviorKind;
  triggeredAt: string;
  trigger: string;
  dryRun: boolean;
  result: "completed" | "skipped" | "failed";
  sessionId?: string;
  error?: string;
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
2. 新增静态表格 + 详情面板，所有保存和测试控件 disabled。
3. 表格先展示 core 文档已有的三个事件驱动型 sleep 行为。
4. 随机触发型先以 `planned` / `disabled` 示例行展示，不接入调度器。
5. 增加本地行选择交互，让详情面板随选中行为变化。
6. 接入 `GET /admin/api/initiated-behaviors` 后，把静态数据替换为真实配置。
7. 接入保存 API 后，再开放 `enabled`、`cooldownMinutes`、`dryRun` 等编辑。
8. 增加 `Recent runs` 观测接口。
9. 等随机调度器设计完成后，再开放概率、时间窗和每日上限配置。

## 开放问题

- 主动行为配置应归 `apps/api` 的 admin 配置文件，还是归 `core/agent` 包提供默认 schema 后由 admin 保存覆盖？
- `promptInstruction` 是否允许完全由 admin 编辑，还是只能编辑少量变量和模板片段？
- 随机触发型是否需要全局 master switch，防止所有随机行为一次性禁用？
- `allowedChannels` 应该使用 channel 类型、具体 session，还是 plugin/account/channel 三级目标？
- dry-run 结果是否需要写入和真实触发同一张 runs 表？
