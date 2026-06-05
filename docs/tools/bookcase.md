# Bookcase Tool

`bookcase` is an LLM-visible tool bundle implemented in `tools/bookcase/src/index.ts`.

## Tool

- `bookcase({ action: "draw", ...filters })`: draws a source book summary, returns the story master text, and enters fixed-prefix mode.
- `bookcase({ action: "return" })`: returns the book, clears fixed-prefix mode, and invalidates the current LLM session.

Supported filters for `draw` are `title`, `author`, `genre`, `minSummaryChars`, and `seed`.

## Runtime Behavior

The default summary database is `tools/bookcase/assets/booksummaries.sqlite`.

`draw` sends `-少女已取书-` when a current output target is available. `return` sends `-少女已还书-`. Both notices are runtime side effects; the LLM-facing tool schema only exposes the `bookcase` input fields.

## Classification

This is a root `tools/` package because it implements `ToolPlugin`, exposes a function-calling schema through `listTools()`, and is not a channel/service plugin.
