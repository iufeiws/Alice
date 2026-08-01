# Agent 状态预期行为

本文档记录 Agent 状态机在修改实现和测试前需要确认的预期行为。

## 目标

- `going_to_sleep` 是真实的入睡倒计时状态。用户交互可以推迟入睡，但不能取消入睡。
- `sleep_cocoon in` 只记录一次入睡指针，并保留到睡眠完成或睡眠茧被显式取消。
- `working` 已废弃；普通聊天、Codex 任务、后台任务和普通 heartbeat 都不应进入 `working`。
- 状态机必须实现每个状态的回复延迟、消息处理后落点、活动计时和自动切换。
- 测试应直接描述预期的睡眠和状态切换行为，让回归问题更容易暴露。

## 状态总表

| 状态 | 含义 | 回复延迟 | 消息处理后落点 | 活动计时与自动切换 |
| --- | --- | --- | --- | --- |
| `idle` | 空闲 | 20-120 秒 | 处理用户消息后进入 `waiting`。 | 随机 2-15 分钟计时器；到期时以 `1/2 * 亲密度` 的概率进入 `waiting`，以 `0.1` 概率进入 `away`，否则继续 `idle`。 |
| `waiting` | 等用户反馈 | 8-15 秒 | 处理用户消息后保持 `waiting`。 | 活动计时恢复后 30 分钟没有新活动，降级到 `idle`，并触发 LLM 会话更新。 |
| `away` | 暂离 | 5-30 分钟 | 不处理用户消息；回归后先进入 `waiting`，再按延迟规则一次性处理期间收到的全部未处理消息。 | 暂离计时结束后降级到 `waiting`；如果暂离期间有新消息，回归后回复时应给出暂离理由。 |
| `curious` | 想发起话题 | 8-12 秒 | 处理用户消息后进入 `waiting`。 | 尝试延伸话题；活动计时恢复后 5 分钟没有新活动，降级到 `waiting`。 |
| `working` | 正在处理任务（已废弃） | 不回复中间留言 | 不应出现；旧持久化状态恢复时回退到安全可用状态。 | 已废弃，当前不应由任何新流程进入。 |
| `going_to_sleep` | 入睡中 | 8-15 秒 | 处理用户消息后仍保持 `going_to_sleep`；消息只暂停入睡计时，不取消睡眠茧。 | 活动计时恢复后 5 分钟没有新活动，进入 `sleeping`。 |
| `sleeping` | 睡眠 | 不回复 | 不处理用户消息；醒来后再按延迟规则一次性处理睡眠期间收到的全部未处理消息。 | 由 LLM 命令预约进入，必须先进入 `going_to_sleep`；睡眠 6-10 小时，结束时触发早安并进入 `waiting`。 |
| `serious` | 严肃 | 8-15 秒 | 处理用户消息后保持 `serious`。 | 处理 Codex 等任务时的状态；不进入 `idle`，也不切入已废弃的 `working`。 |
| `test` | 测试 | 8 秒 | 处理用户消息后保持 `test`。 | 用于测试/调试，不参与普通随机状态游走。 |

## 状态细则

`idle`

空闲状态。收到用户消息时可以回复，但回复延迟应在 20-120 秒之间。自身有随机 2-15 分钟计时器，到期后按亲密度概率进入 `waiting`，或以 `0.1` 概率进入 `away`。

`waiting`

等待用户反馈状态。收到用户消息时按 8-15 秒延迟回复。活动计时恢复后 30 分钟没有新活动时降级到 `idle`，并清理当前活跃 LLM session，使下一轮回复重建会话上下文。

`away`

暂离状态。收到用户消息时不立即回复。暂离计时结束后回到 `waiting`；如果暂离期间存在新消息，之后回复时应说明或体现暂离理由。

`curious`

想发起话题状态。回复延迟为 8-12 秒，行为上应努力延伸话题。活动计时恢复后 5 分钟没有新活动时降级到 `waiting`。

`working`

已废弃的历史预留状态。它原本用于用户明确交代的任务：任务完成前不对中间留言做回复，任务结束后降级到 `waiting`。当前不应由普通聊天、普通 tool call、普通 heartbeat、Codex 任务或后台任务进入。

`going_to_sleep`

入睡中状态。回复延迟为 8-15 秒。Agent 仍然醒着并可以回复；用户入站消息会暂停进入 `sleeping` 的倒计时，主 LLM 请求结束或消息成功发出后再从该时刻重新开始 5 分钟倒计时。

## 活动计时语义

`nextTransitionAt` 有值时表示计时中；字段缺失时表示活动计时暂停。暂停不是一个极远的伪 deadline。

- 收到用户入站消息时暂停活动计时，并继续记录 `lastInboundAt`。
- 发起 `chat` 或 `talk` 主 LLM 请求时暂停活动计时。
- 主 LLM 请求成功返回、失败或取消并完成 settlement 后，从该时刻恢复活动计时。
- 任意消息通过统一 output router 成功发出后，从发送成功时刻恢复活动计时；发送失败不刷新计时。
- 普通工具执行本身不暂停或恢复活动计时。LLM 返回 tool call 后计时已经恢复，因此长时间工具执行期间仍可到期。
- Memorize、图片识别、ASR 等后台或辅助 LLM 请求不改变 Agent 活动计时。
- 恢复时按当前状态选择期限：`waiting` 为 30 分钟，`idle`、`curious`、`going_to_sleep` 为 5 分钟；其他状态保留各自的状态期限，不参与本活动计时。

`sleeping`

睡眠状态。Agent 不回复入站消息，也不运行普通 heartbeat 工作。它由 LLM 命令预约进入，并必须先经过 `going_to_sleep`。睡眠时长为 6-10 小时；结束时触发早安流程并进入 `waiting`。

`serious` 和 `test`

`serious` 是严肃处理 Codex 等任务时的状态。它不进入 `idle`，也不再切入已废弃的 `working`。`test` 用于测试/调试，固定 8 秒回复延迟，不参与普通随机状态游走。

如果消息处理期间工具或显式命令改变了状态，以显式状态变更为准：

- `sleep_cocoon in`：处理结束后应处于 `going_to_sleep`。
- `sleep_cocoon out`：仅在 `going_to_sleep` 时取消睡眠茧，处理结束后处于 `waiting` 并清理睡眠茧指针。
- `/force_wake`：处理后处于 `waiting`，清理睡眠茧指针，清理活跃 LLM session，并排队一次 sleep cocoon force wake generated event。
- 进入 `sleeping` 的状态切换只能由 `going_to_sleep` 的无消息倒计时到期触发，普通消息处理完成本身不能直接把状态设为 `sleeping`。
- 废弃的 `working` 不能作为“处理前状态快照”或“处理后恢复目标”参与普通消息处理，因此不能出现 `任意状态 -> working -> waiting` 的隐式落点路径。

## 睡眠茧流程

1. `sleep_cocoon({"action":"in"})` 将状态设为 `going_to_sleep`。
2. 它会记录：
   - `sleepCocoonEnteredAt`
   - `sleepDurationMs`
   - `nextTransitionAt`
   - `reason: "sleep_cocoon_in"`
3. 如果没有新的用户活动推迟入睡，`nextTransitionAt` 就是 Agent 应该变为 `sleeping` 的时间，默认是进入 `going_to_sleep` 后 5 分钟。
4. 在 `going_to_sleep` 期间，用户入站消息会更新 `lastInboundAt`，并把 `nextTransitionAt` 推迟到该消息之后 5 分钟。
5. 处理这些消息后，状态必须仍然是 `going_to_sleep`。
6. 当 `tick()` 发现推迟后的 `nextTransitionAt` 已到期，状态切换为 `sleeping`，`reason` 为 `sleep_started`。
7. 进入 `sleeping` 时记录睡眠边界、清理活跃 LLM mode/session、在合适时发送 `-少女已入眠-`，并启动睡眠记忆归纳。
8. 睡眠持续时间到期后，`tick()` 将 `sleeping` 切换为 `waiting`，`reason` 为 `woke`。
9. 醒来时重新抽取每日外壳，并可以排队 morning generated event。

## `going_to_sleep` 期间的交互

`going_to_sleep` 期间的用户入站消息应正常处理，但它们只会推迟入睡。

预期例子：

1. `03:42:10` 进入 `going_to_sleep`，`nextTransitionAt = 03:47:10`。
2. 用户在 `03:42:34` 发送消息。
3. 状态仍然保持 `going_to_sleep`。
4. `lastInboundAt = 03:42:34`。
5. `nextTransitionAt` 移动到 `03:47:34`。
6. 更多用户消息重复同样的推迟逻辑。
7. 当不再有消息且 deadline 已过，下一次 heartbeat tick 进入 `sleeping`。

重要的非目标：用户消息不会调用 `sleep_cocoon out`，不会清理 `sleepCocoonEnteredAt`，也不会让 Agent 回到 `waiting`。

## `working` 废弃规则

`working` 是历史预留状态，目前废弃。它不是普通聊天的处理锁，也不是 Codex/后台任务的当前实现状态。

当前预期行为：

- 普通入站聊天处理不应自动调用 `noteWorkStarted()`。
- 普通 generated heartbeat session 不应自动调用 `noteWorkStarted()`。
- 普通 LLM turn 内部的 tool call 不代表进入 `working`。
- Codex 任务或后台任务当前也不进入 `working`。
- 如果 `noteWorkStarted()` 仍保留为兼容 API，它应是 no-op，不能改变当前状态。
- `noteWorkFinished()` 不能用过期的 baseline state 覆盖更新后的状态。
- 不应存在 `going_to_sleep -> working -> waiting` 的路径。
- 旧持久化快照如果处于 `working`，恢复时应降级到安全可用状态。已有 `previousState: "serious"` 时恢复到 `serious`，否则恢复到 `waiting`。
- `working` 不承担锁语义；执行互斥统一由 message runtime 的 LLM 活跃状态和会话级 processing 标记管理。

## Heartbeat 运行约束

Heartbeat 由 message runtime 管理，是驱动状态 tick、generated event 和未处理消息的后台循环。

### 调度与暂停

- Runtime 创建后会立即调度一次 heartbeat，默认间隔为 1000 毫秒；测试或调用方可通过 `getHeartbeatIntervalMs()` 覆盖。
- 如果 `startHeartbeatPaused` 为真，创建后不自动运行 heartbeat。
- `pauseHeartbeat()` 会暂停 heartbeat，并清除已存在的 timer。
- `resumeHeartbeat()` 会恢复 heartbeat，并立即调度一次运行。
- Agent 状态发生变化时，runtime 会立即调度一次 heartbeat，用于尽快处理状态切换后的新条件。
- 新入站消息写入未处理消息集合后，也会立即调度一次 heartbeat。
- 同一时刻最多只能存在一个 heartbeat timer；已有 timer 时再次调度不会创建重复 timer。
- `flushAll()` 会清除 heartbeat timer，并取消状态变化监听。它不应强制处理未处理入站消息。

### 单次 heartbeat 顺序

单次 heartbeat 的执行顺序必须保持如下：

1. 非 force 模式下，先检查 idle 计时器是否到期；到期且 gate 允许时执行 idle transition hook。
2. 如果 idle 到期、gate 允许且没有 pending 用户消息，先尝试随机主动行为；触发成功后本轮结束。
3. 调用 `agentState.tick()`，推进普通状态计时器。
4. 如果不是 force 模式，并且当前不能运行 heartbeat，则重新调度下一次 heartbeat 后退出。
5. 如果可以运行 heartbeat，调用 `onHeartbeatTick()`；当前 API 进程用它执行每轮轻量维护。
6. 检查 ready talk session，并尝试运行 Talk loop。
7. 检查并处理 sleep cocoon morning generated event。
8. 在不存在未处理消息且没有正在处理的用户消息时，检查并处理 sleep cocoon goodnight generated event。
9. 遍历有未处理消息的会话，按条件一次性处理该会话当前全部未处理入站文本消息。
10. 非 force 模式下，结束后重新调度下一次 heartbeat。

### Heartbeat gate

普通 heartbeat 只有在以下条件都满足时才继续处理 generated event 和未处理消息：

- 当前没有活跃 LLM session。
- `agentState.canRunHeartbeat()` 返回真。

如果 gate 不通过，heartbeat 不处理 generated event，不处理用户消息，只重新调度下一次 heartbeat。

`canRunHeartbeat()` 当前应在 `away`、`sleeping` 和已废弃的 `working` 状态返回假。`going_to_sleep` 仍允许 heartbeat 运行，因为该状态需要处理用户消息并推迟入睡。

### 未处理用户消息处理

- 入站事件会先调用 `agentState.noteInboundMessage()` 暂停活动计时，再写入消息日志和 Core 侧消息表。
- 文本消息会进入未处理消息集合；非文本消息会立即标记为已处理，不进入普通 Core 文本处理队列。
- `/force_wake` 是特殊命令：记录入站活动后，直接将状态设为 `waiting`，清理睡眠茧指针，清理活跃 LLM session，并排队一次强制唤醒 generated event；命令本身不进入普通消息处理。
- 这里的“未处理消息”只是消息存储状态，不是 Agent 状态机里的独立状态。
- `waiting -> idle` 的无消息降级会清理活跃 LLM session，清理原因使用 `mode_transition`。
- 有未处理消息的会话以 session id 去重；同一 session 已在 processing 时，不重复处理。
- 处理前会读取该会话当前全部未处理 Core 消息；一次触发处理的输入应覆盖该会话当前全部未处理消息。
- 如果该会话没有未处理消息，应从未处理会话集合移除。
- 普通模式下，只有在当前代码的 `shouldProcessPending()` 判定为真时才处理该会话的未处理消息。
- 当前代码的 `shouldProcessPending()` 必须同时满足：
  - `agentState.canReplyToInbound()` 为真；
  - 最新一条未处理消息距离当前时间已超过 `agentState.getInboundDelayMs()`，没有 agentState 时使用 runtime 默认 `getDelayMs()`。
- 因此 `away`、`sleeping` 和已废弃的 `working` 状态不会处理用户消息。
- `going_to_sleep` 可以处理用户消息；处理前的 `noteInboundMessage()` 会清除入睡 deadline，主 LLM 请求结束或消息成功发出后再恢复。
- 一次消息处理以会话为单位；处理成功后写出 outbound、标记本次读取到的全部消息已处理，并在该会话没有剩余未处理消息时移出未处理会话集合。
- 处理失败时记录错误日志；Core 内部失败路径会把该批消息标记为 core failed，避免同一批无限重试。

### Generated event 处理

- Morning generated event 只在普通 heartbeat 且 heartbeat gate 通过时检查。
- Morning event 来自 `pendingSleepCocoonMorningEvent`，读取后会被清空，因此最多消费一次。
- Goodnight generated event 只在普通 heartbeat、heartbeat gate 通过、且不存在未处理消息和正在处理的用户消息时检查。
- Goodnight event 由睡眠茧自动晚安逻辑生成；如果存在未处理用户消息，应优先处理用户消息，不能同时触发自动晚安。
- Generated event 运行时会占用对应 session 的 processing 标记；如果该 session 正在 processing，则跳过本次 generated event。
- Generated event 失败只记录日志并返回失败，不应让 runtime 崩溃。

### 手动处理

- `processNow()` 会先从 store 恢复有未处理消息的会话，然后以 force 模式运行一次 heartbeat。
- Force heartbeat 仍会先调用 `agentState.tick()`，但会跳过普通 heartbeat gate。
- Force heartbeat 不运行 morning/goodnight generated event。
- Force heartbeat 会忽略未处理消息的回复延迟限制，但仍通过现有会话处理流程处理消息。
- 如果 force heartbeat 没有处理任何未处理消息，会尝试运行 manual session。
- Manual session 需要默认消息目标；没有目标时只记录 warning。

## 需要新增或调整的测试

Agent state 测试：

- `idle` 的回复延迟为 20-120 秒。
- `idle` 的计时器为随机 2-15 分钟，到期后按概率进入 `waiting`、`away` 或继续 `idle`。
- `waiting` 的回复延迟为 8-15 秒，活动计时恢复后 30 分钟没有新活动时降级到 `idle`。
- `away` 的回复延迟为 5-30 分钟，计时结束后降级到 `waiting`。
- `away` 期间收到新消息时，回归后的回复应能携带暂离理由。
- `curious` 的回复延迟为 8-12 秒，5 分钟无消息后降级到 `waiting`。
- `working` 已废弃；`noteWorkStarted()` 不改变当前状态。
- `working` 已废弃；旧持久化 `working` 状态恢复时回退到安全状态。
- `serious` 不进入 `idle`，也不切入 `working`。
- `going_to_sleep` 在 deadline 到期时切换到 `sleeping`。
- `going_to_sleep` 在被推迟时保留 `sleepCocoonEnteredAt` 和 `sleepDurationMs`。
- `going_to_sleep` 下调用 `noteInboundMessage()` 会更新 `lastInboundAt` 并清除 `nextTransitionAt`。
- 主 LLM 请求开始时暂停活动计时，成功、失败或取消 settlement 后恢复活动计时。
- 消息成功发出后恢复活动计时，发送失败不刷新计时。
- 普通工具执行和辅助 LLM 请求不改变活动计时。
- `going_to_sleep` 下调用 `noteInboundMessage()` 不会把状态改成 `waiting`。
- 普通聊天处理不能把 `going_to_sleep` 改成 `working` 或 `waiting`。
- `noteWorkFinished()` 不能把 `going_to_sleep` 覆盖成 `waiting`。
- 正常聊天路径不会进入 `working`。
- 各状态处理消息后的默认落点符合状态总表。

Message runtime 测试：

- `going_to_sleep` 期间的未处理消息会在配置的回复延迟后被处理。
- 处理该消息后，Agent 状态仍然是 `going_to_sleep`。
- 睡眠 deadline 会在最新入站活动时暂停，并在主 LLM settlement 或消息发送成功后恢复。
- 恢复后的 deadline 过去且没有活跃 session 后，heartbeat tick 会切换到 `sleeping`。
- 活跃用户聊天或未处理用户消息会推迟入睡，但不会取消睡眠茧。
- 普通入站处理期间不会观察到 `working` 状态。
- `idle` 处理用户消息后落到 `waiting`。
- `curious` 处理用户消息后落到 `waiting`。
- `going_to_sleep` 处理用户消息后仍保持 `going_to_sleep`。
- `serious` 处理用户消息后仍保持 `serious`。
- `test` 处理用户消息后仍保持 `test`。
- 普通 heartbeat 会先处理 idle 到期的随机主动行为机会，再调用 `agentState.tick()`。
- `waiting -> idle` 的无消息降级会触发 LLM session 清理。
- heartbeat 在 LLM session 活跃或 `canRunHeartbeat()` 为假时不处理用户消息，并重新调度。
- 新入站消息和状态变化都会唤醒 heartbeat。
- 未处理消息只有在最新消息超过状态回复延迟后才处理。
- 一次会话处理应覆盖当前全部未处理消息。
- `away`、`sleeping` 和已废弃的 `working` 不处理用户消息。
- sleep cocoon goodnight generated event 在存在未处理消息或正在处理用户消息时不运行。
- sleep cocoon morning generated event 只消费一次。
- `processNow()` 的 force heartbeat 不运行 morning/goodnight generated event；没有未处理消息时才尝试 manual session。
- `flushAll()` 只停止 heartbeat，不强制处理未处理入站消息。

Sleep cocoon tool 测试：

- `sleep_cocoon in` 进入 `going_to_sleep` 并启动倒计时。
- `sleep_cocoon out` 只在仍处于 `going_to_sleep` 时取消。
- `sleep_cocoon out` 会清理睡眠茧指针。
- `sleep_cocoon out` 不会唤醒已经 `sleeping` 的 Agent。

## 待审阅问题

- 只有用户入站消息推迟入睡，还是 outbound-only 活动也应推迟？
- `away` 回归后“给出理由”的理由来源是固定模板、随机生成，还是由状态切换时记录？
