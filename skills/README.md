# Skills 说明

Skill 包根目录。当前运行时尚未加载或执行这里的 skills。

规划中的 skill 分组：

- `builtin`
- `codex`
- `media`
- `web`
- `custom`

未来 skill 应定义元数据、输入/输出 schema、prompt 模板与可选 handler。当前 AgentCore 会执行已注册的 Tool Plugin，但不会从这个目录自动发现或加载 skill。
