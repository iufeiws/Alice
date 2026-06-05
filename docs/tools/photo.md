# Photo Tool

`photo` is an LLM-visible tool bundle implemented in `tools/photo/src/index.ts`.

## Tool

- `selfie({ action, aspectRatio? })`: generates an Alice selfie/photo from the action description, current character context, shell/outfit context, and reference images, then sends the image to the current chat session.

`aspectRatio` defaults to `3:4`; supported values are `1:1`, `4:3`, `3:4`, `16:9`, and `9:16`.

## Runtime Behavior

The tool sends `-少女拍照中-` before generation. Generated images are written under `assets/generated/selfies/`, and reference assets are read from `assets/selfie/references/` plus the current outfit image when available.

Configuration and the manual API smoke command are documented in `tools/photo/README.md`.

## Classification

This is a root `tools/` package because it implements `ToolPlugin`, exposes the LLM-visible `selfie` function, and is not a channel/service plugin.
