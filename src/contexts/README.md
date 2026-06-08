# contexts

`contexts/` 是系统核心业务边界。每个 context 表达一个业务概念，内部按职责使用：

- `domain/`: 领域模型、纯规则、类型。
- `application/`: 用例和应用服务。
- `ports/`: 外部依赖端口。
- `adapters/`: 持久化/第三方/文件等适配。
- `runtime/`: runtime composition 或生命周期。
- `contracts/`: 对外 DTO、事件协议。

当前 context：

- `agent-loop/`: chat/talk agent loop 与 AgentCore。
- `agent-profile/`: prompt/profile/shell/persona。
- `conversation-hub/`: conversation/message/log 归一化和存储入口。
- `initiative/`: 主动行为配置、触发和运行记录。
- `llm-gateway/`: LLM request、client、tool-loop、观测。
- `llm-session/`: LLM session 指针、归档、列表和视图。
- `memory/`: 长期记忆、记忆归纳、sleep window。
- `talk-session/`: 实时对话 session、chunk、interrupt。
