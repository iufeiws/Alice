# shared

`shared/` 放无业务语义、跨层可复用的小类型和工具。这里不能依赖 `apps/`、`contexts/`、`channels/` 或 `capabilities/`。

当前模块：

- `clock/`: current-time provider 类型。
- `uuid/`: ID 生成 helper。
