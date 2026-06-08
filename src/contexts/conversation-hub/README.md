# conversation-hub

## Owns

- 统一的会话消息聚合
- conversation-id 及消息列表/日志的持久化访问

## Does not own

- 会话上下文编排
- LLM 请求与 tool-call 流程
- 话务渠道/平台级入出站接入逻辑

## Public API

仅通过 `src/index.ts` 对外导出。

## Dependency rules

- 允许依赖 `platform/storage` 等基础设施；不依赖 `apps` 或 channel SDK
- 不直接依赖 `channels/*` 渲染层

## File placement

- `domain/`: 会话域模型
- `application/`: 消息接入/存储应用逻辑
- `ports/`: 对存储/输出/心跳等外部依赖接口
- `adapters/`: SQLite 与日志落盘适配
- `runtime/`: 组装与生命周期
- `contracts/`: 外部 DTO 与事件协议
- `src/index.ts`: 对外导出（待迁移完成补充）
