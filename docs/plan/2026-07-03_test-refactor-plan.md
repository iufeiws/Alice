# 测试重构计划

## 目标

将现有 `tests/` 重构为与 `src/` 对齐的目录结构，单个测试文件不超过 500 行，并把测试断言收敛到用户可见结果、接口契约、数据状态和业务事件。

本计划保留 prompt/tool 的关键契约测试，但删除或改写对具体 prompt 文案、tool 描述文本、完整返回 JSON 形状、参数顺序和中间实现细节的硬编码断言。

## 当前问题

- 仓库当前使用 `tests/`，没有 `test/` 目录。
- 多个测试文件超过 500 行，例如 `messaging-tools.test.ts`、`agent-tools.test.ts`、`webrtc-voice-plugin.test.ts`、`admin-routes.test.ts`、`message-runtime.test.ts`。
- 部分测试同时覆盖多个核心行为，Arrange/Act/Assert 边界不清。
- 部分断言锁定了 prompt 文案、tool schema 细节、LLM 消息内部排列或假 tool call 的具体格式，导致测试约束实现而不是约束契约。
- Python 缓存文件位于 `tests/__pycache__/`，不应保留在测试源目录结构中。

## 目录迁移规则

按被测源码路径镜像迁移测试：

- `src/apps/api/...` -> `tests/apps/api/...`
- `src/capabilities/tools/messaging/...` -> `tests/capabilities/tools/messaging/...`
- `src/contexts/agent-loop/...` -> `tests/contexts/agent-loop/...`
- `src/channels/wechat/...` -> `tests/channels/wechat/...`
- `src/platform/time/...` -> `tests/platform/time/...`
- `src/shared/...` -> `tests/shared/...`

跨上下文流程测试放在离入口最近的位置。若入口是 API，放在 `tests/apps/api/`；若入口是 Agent loop，放在 `tests/contexts/agent-loop/`；若入口是具体 tool，放在对应 `tests/capabilities/tools/<tool>/`。

## Case 命名规则

统一使用：

```text
<feature>_<condition>_<expectedResult>
```

示例：

- `chatSend_validText_persistsOutboundMessage`
- `agentLoop_visibleToolCall_executesViaToolPlugin`
- `promptPreview_coreLayers_matchesLlmRequest`
- `adminRoute_invalidPayload_returnsJsonError`

## 保留测试

保留并重写为契约测试的范围：

- Prompt Preview 与实际 LLM request 的消息序列一致。
- prompt layer 顺序只由公共解析器入口决定。
- 运行时不追加 preview 不可见的隐藏 prompt。
- LLM request 只暴露 `toolNames` 指定的可见 tools。
- LLM 已收到并调用的 tool 走统一 `ToolPlugin.execute`。
- tool result 写回同一个 function-call loop。
- Admin API 的授权、输入校验和 JSON 错误。
- 数据库写入、读取、迁移路径和可重复测试数据。
- 渠道插件的用户可见输出、接口请求和持久化结果。

## 删除或改写测试

删除：

- 只断言内部 helper 调用顺序，且没有用户可见结果或接口契约的 case。
- 只为了覆盖率存在、没有明确需求来源的 case。
- 依赖固定 sleep、共享状态或执行顺序的 case。
- 断言完整 prompt 文案、tool 描述文本、完整 tool schema 快照的 case。
- 断言 fake tool call 返回格式但不覆盖真实契约的 case。

改写：

- prompt 测试改为断言“是否存在隐藏 prompt、layer 顺序是否一致、preview 是否等于 request”，不断言整段文案。
- tool 测试改为断言“是否暴露、是否执行、是否产生契约输出”，不快照完整 schema 或描述文本。
- UI 测试使用 role、label、text 或 testid selector，不绑定 DOM 结构和 CSS 细节。
- 异步测试改为事件、promise、fake clock 或可观察状态，不使用固定 sleep。

## 分阶段计划

### 1. 建立测试清单

生成测试索引，记录每个文件的目标位置、行数、需求来源、测试层级和处理动作：

- `keep`：保留。
- `split`：拆分到多个文件。
- `rewrite`：保留意图但改断言。
- `delete`：删除不满足规范的 case。

验收：

- 每个现有测试文件都有处理动作。
- 所有超过 500 行的文件都有拆分目标。
- 每个 `delete` 都写明删除原因。

### 2. 删除不合规 case

逐个删除无需求来源、无用户可见结果、无接口契约或只断言内部实现的 case。

同时处理明显不该保留的测试源文件生成物，例如 `tests/__pycache__/`。

验收：

- 删除记录能追溯到测试索引。
- 删除后仍覆盖对应 API、UI、integration 或 contract 的关键路径。
- 不用兼容性 fallback 补旧测试。

### 3. 重写 prompt/tool 脆弱断言

把硬编码格式断言改成契约断言。无法改成契约断言的 case 直接删除。

示例方向：

- 从 `assert.match(promptText, /具体文案/)` 改为断言 preview 和 request 使用同一 layer 输出。
- 从 `assert.deepEqual(tool.inputSchema, {...})` 改为断言必须字段存在、非法输入被拒绝、合法输入产生契约结果。
- 从 `assert.equal(tool.description, "...")` 改为删除，除非 API spec 明确要求该文本。
- 从完整 message 序列快照改为断言关键业务事件和 tool execution 发生在同一个 loop。

验收：

- prompt/tool 测试不再锁定非契约文案。
- 保留防隐藏 prompt 和 tool 执行路径契约。
- 修改 prompt 文案或 tool 描述不会破坏无关测试。

### 4. 拆分超长文件

按 feature 和被测入口拆分，单文件上限 500 行。

优先拆分：

- `tests/messaging-tools.test.ts`
- `tests/agent-tools.test.ts`
- `tests/webrtc-voice-plugin.test.ts`
- `tests/admin-routes.test.ts`
- `tests/message-runtime.test.ts`
- `tests/llm-and-storage.test.ts`
- `tests/photo-tools.test.ts`
- `tests/sleep-memory.test.ts`
- `tests/asr-plugin.test.ts`

验收：

- 所有测试文件不超过 500 行。
- 每个文件只覆盖一个清晰 feature 或入口。
- 公共测试数据构造只抽到同目录 helper，避免全局测试工具箱。

### 5. 稳定性治理

移除固定 sleep、共享临时目录和顺序依赖。

验收：

- 测试数据可重复创建。
- 每个 case 自己 Arrange 和 Cleanup。
- 异步等待基于可观察结果。
- 失败时保留必要 log、trace、screenshot 或 request id。

### 6. 迁移目录结构

最后只做路径重构：按 `src/` 镜像结构移动已经清理和拆分过的测试文件，修正 import 路径。

验收：

- `npm test` 可运行到与迁移前等价的结果。
- `tests/` 下不再有根目录平铺的大型测试文件。
- 不保留 `__pycache__` 这类生成物。

### 7. 更新测试命令

如果迁移后测试文件不再只位于 `dist/tests/*.test.js`，更新 `npm test` 的 glob，使它递归执行：

```json
"test": "npm run build && node --test --test-concurrency=1 dist/tests/**/*.test.js"
```

验收：

- `npm test` 覆盖迁移后的全部测试文件。
- `npm run typecheck` 通过。

## 单个 Case 模板

```text
Case 名称：
<feature>_<condition>_<expectedResult>

需求/契约来源：
PRD / API spec / user story / bug ticket / acceptance criteria 链接

测试层级：
API / UI / E2E / integration / contract

前置条件：
只写影响本 case 结论的条件，测试数据必须可重复创建

操作步骤：
1. Arrange：创建必要数据，优先 API
2. Act：执行被测行为，只执行一个核心行为
3. Assert：断言用户可见结果或接口契约
4. Cleanup：清理数据，或使用临时隔离环境

断言：
- 状态码 / 页面可见结果 / 数据状态 / 业务事件
- 不断言内部实现
- 不加无关断言

稳定性要求：
- 不依赖执行顺序
- 不依赖共享状态
- 不使用固定 sleep
- selector 使用 role / label / text / testid
- 失败时保留 log / trace / screenshot / request id
```

## 完成标准

- `tests/` 与 `src/` 目录结构一致。
- 所有测试文件不超过 500 行。
- 每个 case 名称符合 `<feature>_<condition>_<expectedResult>`。
- 每个 case 有明确需求或契约来源。
- prompt/tool 测试只约束契约，不约束非契约格式和文案。
- 不合规测试已删除或改写。
- `npm run typecheck` 和 `npm test` 通过。
