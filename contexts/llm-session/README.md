# llm-session

Owns:

- LLM 会话会话指针与轮次状态
- 会话归档文件（llm-sessions）读写与恢复
- 会话列表和视图聚合逻辑
- admin 侧会话查询与会话预览输入

Depends on:

- `core/agent`（日志持久化、提示词工具）
- `core/llm`（请求模型与 request 对比）
- `core/time`

Public API:

- 导出位于 [src/index.ts](./src/index.ts)

