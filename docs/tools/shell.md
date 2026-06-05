# Shell Tools

`shell` is an LLM-visible tool bundle implemented in `tools/shell/src/index.ts`.

## Tool

- `wardrobe({ action: "list", name? })`: lists available outfits, optionally filtered by name/id/group/content.
- `wardrobe({ action: "mirror" })`: returns the current outfit description.
- `wardrobe({ action: "switch", name })`: switches the current outfit and sends `-少女已更衣-` to the current chat session.

## Runtime Behavior

The tool reads and updates `DailyShellStore`. `switch` requires a current messaging target, stores the notice as an outbound message, sends through `OutputRouter`, and returns the rendered shell state.

## Classification

This is a root `tools/` package because it implements `ToolPlugin`, exposes the LLM-visible `wardrobe` function, and is not a channel/service plugin.
