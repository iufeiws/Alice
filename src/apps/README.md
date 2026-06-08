# apps

`apps/` 只放启动入口和装配代码。允许 HTTP server、routes、middleware、composition root、runtime wiring 和 process lifecycle。

不允许在这里实现业务规则、LLM request 拼装、memory 读写策略、conversation merge 或 agent loop 状态机。发现这类逻辑时应迁到对应 `contexts/`。

当前 app：

- `api/`: 单进程 HTTP API、管理后台和 runtime composition root。
