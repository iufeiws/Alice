# Sleep Cocoon 工具

`SleepCocoon` 是 LLM 可见工具包，当前实现位于 `src/capabilities/tools/sleep-cocoon`。

## 工具

- `sleep_cocoon({ action: "in", hours? })`：进入睡眠茧，启动入睡倒计时。
- `sleep_cocoon({ action: "out" })`：在真正入睡前退出睡眠茧，清理倒计时。

`hours` 只对 `action=in` 有效。传入时，实际时长会加入十五分钟左右的随机抖动。

## 运行行为

`in` 会把 Agent 状态设为 `going_to_sleep`，记录本地时间和 UTC 时间，尽可能发送 `-少女就寝中-`，并进入 fixed-prefix mode。

`out` 只在 Agent 仍处于 `going_to_sleep` 时成功；它会清理睡眠茧状态，尽可能发送 `-少女起床-`，清理 fixed-prefix mode，并使当前 LLM session 失效。

## 分类

该工具是 capability tool，不是 channel plugin。状态语义详见 `docs/core/agent-state.md`。

