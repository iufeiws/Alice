# Sleep Cocoon Tool

`sleep-cocoon` is an LLM-visible tool bundle implemented in `tools/sleep-cocoon/src/index.ts`.

## Tool

- `sleep_cocoon({ action: "in", hours? })`: enters the pre-sleep cocoon state and starts the sleep countdown.
- `sleep_cocoon({ action: "out" })`: exits the cocoon before sleep and clears the countdown.

`hours` is optional for `action=in`. When provided, the actual duration includes a random fifteen-minute jitter in either direction.

## Runtime Behavior

`in` sets agent state to `going_to_sleep`, records local and UTC entry timestamps, sends `-少女就寝中-` when possible, and enters fixed-prefix mode.

`out` only succeeds while the agent is still `going_to_sleep`; it clears the cocoon state, sends `-少女起床-` when possible, clears fixed-prefix mode, and invalidates the LLM session.

## Classification

This is a root `tools/` package because it implements `ToolPlugin`, exposes the LLM-visible `sleep_cocoon` function, and is not a channel/service plugin.
