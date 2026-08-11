# Agent 工作说明

## 项目上下文
ystemctl --user restart alice-agent-tmux.service 用于重启服务
Alice 是一个本地优先的个人 Agent 运行时。当前范围包括 ChatAgent、占位式 Agent 行为、OpenAI 兼容 `/v1` 客户端、飞书与微信渠道插件、本地管理后台、SQLite 消息历史、JSONL LLM 会话归档，以及文件化系统日志。
**project_summary.md 为项目结构总结, 实施前阅读以确定改动目标, 对项目做出改动后必须对其更新**

## 工程规则
- 所有文档必须使用中文撰写；新增或修改 README、设计说明、变更说明、审阅记录等文档时都遵守这一规则。
- 对于边界清晰且已有成熟方案的问题，优先使用维护良好的依赖，不重复造轮子。
- 默认目标是最少维护成本和最低错误率。成熟依赖能替代自维护解析器、协议实现、格式处理、加密、安全校验等细节时，通常比手写更小，因为少了自有代码、边界补丁和长期维护。
- 选择依赖时优先看：语义是否精确覆盖当前问题、维护是否活跃、使用是否广泛、依赖树是否可接受、许可证是否可用、TypeScript/ESM 兼容性、是否有明确测试与安全记录、能否只使用窄 API 而不引入额外执行语义。
- 不要用包体积或“0 dependencies”单点否定更成熟的库；几 MB 体积通常不如解析正确性、维护活跃度和生态成熟度重要。只有在运行环境有明确体积/冷启动/供应链约束时，体积才是主导因素。
- 只有当需求极小、语义完全明确、边界稳定，或现有库会引入不可接受的执行语义/安全面/维护风险时，才手写实现；手写前必须说明为什么成熟库不适用。
- 所有 API 行为变更都需要测试。
- 后端变更需要检查授权和数据校验。
- 数据库迁移需要检查向后兼容和回滚安全。
- 引入新抽象前，先使用项目已有模式。
- 对任何用户行为、测试行为或运行原因做推测前，必须先向用户询问确认；禁止在未确认前直接下判断或把推测当成结论。
- 非重构任务的, 应当保持现有代码结构不变
- 单一代码文件*禁止*超过一千行

## Prompt 构筑硬约束

- **重点：凡是已经有 Prompt 编辑器管理的 Core / Memorize prompt，运行时构筑不得私自追加、前置、包裹任何隐藏 prompt 文本。** 如果确实需要新增固定说明，必须先作为编辑器里的 layer 出现；不可编辑的固定块也必须在编辑器/预览中明确显示。
- **重点：每次修改 prompt、prompt preview、prompt layer schema、LLM request 构筑、fake tool call、Memorize/Core prompt 相关代码前后，都必须审阅是否引入了隐藏 prompt 或改变了 layer 顺序。** 这会破坏用户设计的缓存命中结构，可能导致大额 API 成本损失。
- Prompt Preview 必须反映实际发送给 LLM 的消息序列；不得存在 preview 看不到但运行时会发送的 prompt 内容。
- **重点：项目中所有 prompt layer 解析必须共用同一个解析器入口。** 当前公共入口是 `src/contexts/agent-profile/src/domain/prompt-layer.ts`；不要在 Core、Memorize 或其他模块里复制 `normalize layer`、`layer -> LLMMessage`、tool argument 解析逻辑。

## Tool / Loop 硬约束

- Tool 是否可用只能由 LLM request 构筑阶段的 `toolNames`/visible tools 决定；loop 执行期不得按 loop kind、requester、channel 或 tool name 做二次拦截。
- 一个会话存活期必须保持tool 的暴露scope不变
- LLM 已经收到并调用的 tool 必须走统一 `ToolPlugin.execute` 路径执行，并把 tool result 写回同一个 function-call run loop；不得把 tool result follow-up 交给 heartbeat 或下一次外部 loop 启动。
- `requester` 只表示 tool call 来源，不表示输出投递目标，也不能决定 tool 能不能用。产生 `AgentOutput` 的工具必须通过 capabilities 层的 output target resolver 解析投递目标。

## 运行命令

- `npm run build`：编译 TypeScript 到 `dist/`。
- `npm run typecheck`：运行 TypeScript 类型检查，不输出文件。
- `npm run dev:api`：构建并启动单进程 API/管理后台。
- `npm test`：运行 Node 测试文件。

## GitHub

- GitHub 操作默认使用 SSH remote，例如 `git@github.com:iufeiws/Alice.git`。
- Commit message 必须描述实际变更并提供有用上下文，避免 `update`、`changes`、`update current workspace` 这类含糊信息。

## 运行时状态

- `.env` 保存本地凭据和运行时配置，不要提交密钥。
- 管理后台改动的设置必须持久化到 `.env` 或其他已记录的持久存储；可行时，当前进程应立即应用这些设置。
- 日志类数据，包括 `logs/message/`、`logs/system/` 和 LLM 会话归档，不进入 LLM 上下文。用户要求删除或修改消息历史时，不要删除或编辑这些日志；除非用户明确点名日志存储，否则这类请求只适用于 Core 侧 `messages` 数据。
- `memory-files/indexes/feishu-paired-contacts.json` 保存唯一飞书联系人绑定。
- 运行时代码需要“当前时间”时，应使用 `core/time/src/index.ts` 的全局时间提供器；时区来自 `config.core.timezone`（`AGENT_TIMEZONE`，默认 `Asia/Singapore`）。保存给 Agent 使用的时间戳时，必须使用配置时区下的本地 wall-clock ISO 字符串，例如 `2026-05-25T08:00:00.000`。不要保存 UTC `Z` 时间戳或带 `+08:00` 的 offset 形式；避免直接用 `new Date().toISOString()` 写记录。

## Agent 状态说明

- 当前预期行为：在 `away`、`sleeping` 或 `working` 状态收到的消息，仍会把经过的 wall-clock 时间计入已保存的 `responseDelayMs`；当状态稍后允许回复时，如果旧未处理消息的等待时间已经超过延迟，就可能立刻处理。
- 当前预期行为：ChatAgent 被视为单一非并发 worker。`working` 状态已废弃，普通聊天、Codex 任务、后台任务和普通 heartbeat 都不应进入 `working`。

## Review Checklist

- Admin API 必须校验输入，并返回 JSON 错误，而不是直接抛异常。
- 任何能发送消息、更新凭据、读取本地文件或暴露日志的端点，都必须有明确授权方案。
- LLM 配置变更必须影响活跃 Agent 运行时，而不仅是未来重启。
- SQLite schema 变更在生产使用前需要迁移/版本路径。

## 通用规则
- 修改任何代码前向用户确认该改动目标是符合用户预期的。
- 做出任何对用户行为的假设之前向用户询问是否确实存在该行为。
- 对用户提出的设计抱有疑虑时应当明确向用户提出问题和要求澄清，而不是自行解释。
- Agent loop/function-call loop 不按 tool name、requester 或 channel 特殊拦截工具执行；不可用能力应通过不暴露或不配置 tool 解决，已暴露的 tool call 必须走统一 tool plugin 执行路径。
- 不准自行拼任何硬编码 prompt 在任何位置；看到任何硬编码 prompt 拼接必须明确向用户说明并请求确认。
- 不准自行拼任何硬编码 prompt 在任何位置；看到任何硬编码 prompt 拼接必须明确向用户说明并请求确认。
- 不准自行拼任何硬编码 prompt 在任何位置；看到任何硬编码 prompt 拼接必须明确向用户说明并请求确认。
