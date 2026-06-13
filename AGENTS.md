# AGENTS.md instructions for /home/yf/Alice

- 修改任何代码前向用户确认该改动目标是符合用户预期的。
- 做出任何对用户行为的假设之前向用户询问是否确实存在该行为。
- 对用户提出的设计抱有疑虑时应当明确向用户提出问题和要求澄清，而不是自行解释。
- Agent loop/function-call loop 不按 tool name、requester 或 channel 特殊拦截工具执行；不可用能力应通过不暴露或不配置 tool 解决，已暴露的 tool call 必须走统一 tool plugin 执行路径。
- 不准自行拼任何硬编码 prompt 在任何位置；看到任何硬编码 prompt 拼接必须明确向用户说明并请求确认。
- 不准自行拼任何硬编码 prompt 在任何位置；看到任何硬编码 prompt 拼接必须明确向用户说明并请求确认。
- 不准自行拼任何硬编码 prompt 在任何位置；看到任何硬编码 prompt 拼接必须明确向用户说明并请求确认。
