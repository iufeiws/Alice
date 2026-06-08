# platform

`platform/` 放技术基础设施，不表达 Alice 业务语义。

当前模块：

- `config/`: 通用 env 解析。
- `event-bus/`: in-memory pub/sub。
- `output-router/`: AgentOutput 到 channel 的路由。
- `scheduler/`: 进程内调度和维护任务。
- `storage/`: SQLite/token/diary 等底层存储 helper。
- `text-renderer/`: 通用文本渲染。
- `time/`: timezone-aware current time provider。
