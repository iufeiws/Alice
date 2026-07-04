# Skills 能力

Skills registry 位于 `src/contexts/skills`，LLM 工具入口位于 `src/capabilities/tools/skills`。

## 来源

当前 registry 支持多个 root，例如：

- `src/capabilities/skills`
- `.agents/skills`

每个 skill 通过 `SKILL.md` 暴露说明。

## LLM 工具

LLM 通过 `Skill` 工具加载指定 skill。工具返回 skill 名称、sandbox root 和说明内容。

## Bash Sandbox

需要执行命令的 skill 依赖 bash sandbox runtime。命令权限和挂载边界由 bash sandbox 决定，不由 skill 自行绕过。

## Prompt 边界

Skill 内容是显式工具返回结果，不应被运行时隐藏拼入 Core/Memorize prompt。需要固定说明时必须通过可见 prompt layer 管理。
