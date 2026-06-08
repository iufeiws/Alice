# llm-gateway

## Owns

- LLM API client runtime（OpenAI 兼容）
- LLM request 生成、重试与调用日志
- LLM tool loop 与工具调用执行编排
- 请求预览与请求差量分析

## Does not own

- 会话生命周期与仓储实现（由 `session` 负责）
- Tool 插件定义与运行时（由 `agent` 的 tool adapter 负责）

## Public API

- `contexts/llm-gateway/src/index.ts`

## File placement

- `src/index.ts`: 对外导出
- `src/*.ts`: 运行时与域层实现（目前扁平化组织）
