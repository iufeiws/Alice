# 2026-07-06 过时代码与死代码清理记录

## 范围

- 仅清理 `src` 下 TypeScript/JavaScript 代码文件。
- 未修改 JSON prompt、txt prompt、yaml、wrapper 脚本。
- 补审后同步更新了 `src/README.md`、`src/platform/README.md` 中已删除 platform 模块说明。
- 未新增、前置、包裹任何隐藏 prompt。
- 涉及 prompt/LLM request 相关文件时，仅删除未使用 import、未调用私有函数或未读取参数；未改变 layer 顺序、实际发送消息序列、toolNames 暴露逻辑。

## Subagent 复核

每个 subagent 只对应一个 `src` 文件或同文件内一组 TypeScript unused 报告。复核后由主线程统一 patch，避免并发写冲突。

| 文件 | 清理内容 |
| --- | --- |
| `src/apps/api/bootstrap/admin-route-context.ts` | 删除未使用 `AgentBehaviorState` type import。 |
| `src/capabilities/tools/bookcase/src/index.ts` | 删除未调用 `staticMessagesForCall`。 |
| `src/capabilities/tools/messaging/src/index.ts` | 删除未暴露 `searchMessages` 私有路径及其专属 helper；保留 `resolveTarget` 的当前会话检查。 |
| `src/channels/asr/src/index.ts` | 删除未使用 frame type import 和只赋值不读取的 `latestRaw`。 |
| `src/channels/feishu/src/pairing.ts`、`src/channels/feishu/src/index.ts` | 删除未使用 `config` 参数并同步内部调用。 |
| `src/channels/tts/src/*.ts` | 收窄未使用 type import；删除 `config.ts` 未调用 `ttsVoiceModelConfigValue`。 |
| `src/channels/webrtc-voice/src/audio.ts` | 删除未调用 Ogg 增量 parser。 |
| `src/channels/webrtc-voice/src/call-page.ts` | 删除未使用 Node `crypto` import；浏览器脚本仍使用浏览器全局 `crypto`。 |
| `src/channels/webrtc-voice/src/call-runtime.ts` | 删除未使用 import、局部变量、未调用 SDP/peer helper。 |
| `src/contexts/agent-loop/src/**` | 删除未使用 import、局部函数和未读取参数；不改 loop/tool 执行路径。 |
| `src/contexts/agent-profile/src/**` | 删除未使用 prompt 相关 import 和未调用 preview helper；不改 prompt layer 解析或 preview 构筑。 |
| `src/contexts/capabilities/src/admin-plugin-geo-runtime.ts` | 删除内部解析 helper 的未使用 fallback 参数。 |
| `src/contexts/capabilities/src/admin-plugin-runtime.ts` | 保留配置读取副作用，只删除未使用变量绑定。 |
| `src/contexts/capabilities/src/admin-plugin-tts-runtime.ts` | 删除未使用 TTS 上传参数和未调用本地路径 helper；保留现有路径越界检查。 |
| `src/contexts/conversation-hub/src/application/ingest-channel-message.ts` | 删除未调用上下文行格式化 helper。 |
| `src/contexts/initiative/src/domain/initiated-behavior.ts` | 将未读取参数改为 `_promptProfile`，不改变主动行为 prompt/tool 逻辑。 |
| `src/contexts/llm-gateway/src/**` | 删除未使用 type import 和未调用 diff helper；不改 request 构筑。 |
| `src/contexts/llm-session/src/application/**` | 删除未使用 type import 和 helper 参数。 |
| `src/contexts/memory/src/index.ts` | 删除旧 single-target memory induction、旧 single-file apply_patch 工具/parser、旧 git helper；当前 `runMemoryInductionForMessages()` 对 temporary workspace induction 返回 removed 失败，不再执行旧编辑/提交路径。 |
| `src/contexts/talk-session/src/runtime/talk-session-runtime.ts` | 将未读取参数改为 `_time`，保留现有公开函数调用形状。 |

## 特别记录

- `src/contexts/agent-profile/src/domain/shell.ts` 删除了未接入的 daily shell 过期判断链；后续按设计确认删除了 `rolloverHour` 设置面。
- `src/contexts/capabilities/src/admin-plugin-runtime.ts` 没有直接删除 `readMessagingConfigForAdmin(context)` 调用，因为该调用可能承担配置读取/校验副作用；仅移除未使用变量绑定。
- `src/contexts/memory/src/index.ts` 没有把 `_targetFilter` 改成真实过滤逻辑，因为现有测试和运行语义是一次 workspace induction 处理多个 memory 文件。

## 验证

- `node node_modules/typescript/bin/tsc --noEmit --noUnusedLocals --noUnusedParameters --pretty false 2>&1 | rg '^src/'`
  - 结果：无输出。
- `npm run typecheck`
  - 结果：通过。
- `npm test`
  - 结果：通过。

## 未处理项

- 仓库中仍存在超过 1000 行的 `src` 代码文件，包括本次触碰的 `src/contexts/memory/src/index.ts` 和 `src/capabilities/tools/messaging/src/index.ts`。这需要按模块边界拆分文件，不属于本次“可证明死代码/过时代码删除”的最小变更。

## 全量补审追加

用户指出前一轮没有覆盖 `src` 下全部代码文件后，按 `rg --files src -g '*.ts' -g '*.tsx' -g '*.js' -g '*.mjs' | sort` 的 335 个文件清单重新补审。每个文件由一个只读 subagent 审查；因 thread limit 未启动的批次已重试，输出异常的 `src/contexts/memory/src/memory.ts` 已复审。

### 本轮已清理

| 文件 | 清理内容 |
| --- | --- |
| `src/platform/text-renderer/src/index.ts` | 删除未被源码、测试或构建图引用的旧通用 renderer。当前 prompt 文本渲染入口是 `PromptContextRuntime.renderText()`。 |
| `src/platform/event-bus/src/index.ts`、`src/platform/event-bus/README.md` | 删除未接入运行路径的旧 in-memory event bus。 |
| `src/platform/config/src/globals.d.ts`、`src/platform/config/src/node-http.d.ts` | 删除旧手写 Node shim；`@types/node` 改为显式 dev dependency。 |
| `src/contexts/llm-gateway/src/llm-requests-runtime.ts` | 删除只写不读的 `subagentSessions` 索引；保留实际 request/session 关联的 `WeakMap`。 |
| `src/contexts/world-wanderer/src/runtime.ts` | 删除 `lastFailure.at` 未读取字段，直接记录错误消息。 |
| `src/contexts/world-wanderer/src/policy.ts` | 删除 `chooseNextLink()` 返回值里无人读取的 `backtrack` 字段。 |
| `src/contexts/bash-sandbox/src/paths.ts` | 删除未调用的 `isReadOnlyPath()`、`isWritablePath()`。 |
| `src/contexts/bash-sandbox/src/config.ts`、`src/contexts/bash-sandbox/src/index.ts` | 删除未接入配置路径的 skill mount parser/default helper 和相关 barrel export；`rejectSensitiveHostPath()` 收为私有 helper。 |
| `src/contexts/bash-sandbox/src/workspace-runtime.ts` | 删除未被源码、测试或 barrel 消费的 workspace path wrapper。 |
| `src/contexts/bash-sandbox/src/docker-executor.ts` | 删除 `execFile()` 未使用 stream 参数和未读取的内部 `truncated` 返回字段；保留公开 `DockerExecutorResult.truncated`。 |
| `src/contexts/bash-sandbox/src/audit.ts`、`src/contexts/bash-sandbox/src/permission.ts` | 收窄未外部引用的 type export，并删除审计事件中不再写入的 `optionalMounts` 类型字段。 |
| `src/platform/time/src/index.ts` | 删除无人调用的 `previousDailyAnchor()` 和未被本仓使用的 clock type re-export；保留全局时间提供器。 |

### 需要设计确认后再清理

以下候选不在本轮删除范围内；原因是会改变 prompt/admin/API/DB 兼容、用户可配置面、调试 payload 或公开契约。

| 区域 | 待确认项 |
| --- | --- |
| Prompt / initiated behavior admin | `src/contexts/initiative/src/application/admin-runtime.ts` 里手写 prompt layer/tool call 解析应否改为公共 `prompt-layer.ts` 入口；这会改变 `system` layer、`tool_request` 缺省 `name` 等 admin API 行为。 |
| Prompt / shell | `src/contexts/agent-profile/src/domain/shell.ts` 的 `savePromptTemplate` 当前会影响 shell 渲染；需确认 shell 是否继续允许用户编辑 template。 |
| Prompt context variables | `prompt-context-runtime.ts` 是用户 prompt/template 的运行时变量入口，本轮确认保留，不按死代码处理。 |
| LLM request/debug payload | `llm-request-diff.ts` 的 token estimate 字段、`llm-message-sanitization.ts` 的旧 `functionCall/function_call` 兼容、`llm-log-runtime.ts` 的 response fallback、`llm-requests.ts` 日志 `attempt` 字段等会改变调试/归档/兼容行为。 |
| LLM preset/profile 兼容 | `admin-presets.ts`、`llm-api-profile.ts` 的旧 `corePresetName`、顶层数组 preset 文件兼容需要确认是否仍支持旧本地配置。 |
| Tool/output/API 契约 | `tool-output-target.ts` 的 `nonMessageRequesterPlugins`、`outfit-on-body-runtime.ts` 返回 `mime`、`token-usage-store.ts` 的 `byModelBucket/rawUsageJson` 等会改变 HTTP/API 或扩展契约。 |
| DB migration / 历史数据 | `talk-session` 的旧 `breakpoint_char_index` 迁移、`conversation-store`/`diary-store` 的导出存储 API、`sleep_preparation_boundaries` 读删列出方法，需要确认旧库和人工 SQL/脚本是否仍依赖。 |
| Runtime state compatibility | `working` 状态、`noteWorkStarted/noteWorkFinished` no-op、session resolver 空 `sessionId` fallback、agent heartbeat `run` 兼容入口需要确认旧状态/外部构造输入是否还支持。 |
| Admin plugin 展示/配置面 | `plugin.asr.transcribe`、`plugin.image-recognition.recognize` 这类 routePreview 文案，以及 TTS `reference-text` upload 分支，需要确认是删展示、改文案还是保留旧配置。 |
| Public/barrel API surface | 大量 type-only export 或 barrel re-export 仓库内未用，但删除会收窄私有源码路径 API；除本轮强证据项外，需确认是否要做一次统一 public surface 收缩。 |

## 设计确认后追加清理

用户确认先删除 DB 迁移、旧代码/版本兼容、`working` 状态相关逻辑后，追加清理如下：

| 区域 | 清理内容 |
| --- | --- |
| Agent state | 删除 `working` 状态枚举、admin 状态列表项、`noteWorkStarted()` / `noteWorkFinished()` no-op，以及 persisted `working` 恢复兼容测试。当前普通聊天、heartbeat、talk 均不再进入 `working`。 |
| DB migration | 删除 `talk-session` 旧 `breakpoint_char_index` 表重建迁移；删除 diary/calendar/token usage/initiative/conversation store 的旧列补齐迁移；删除 conversation store 旧 user_version 分支、旧 event log 回填、旧主库到分库搬迁和旧表清理。当前只初始化当前 schema。 |
| LLM preset/profile 兼容 | 删除 `corePresetName` 读写兼容和顶层数组 `llm-api-presets.json` 兼容；admin UI 只使用 `chatPresetName`。 |
| LLM message 兼容 | 删除旧 `functionCall` / `function_call` assistant message 兼容判断，只按当前 `toolCalls` 判断。 |
| Memory prompt 兼容 | 删除 Memorize prompt layer 中旧 `Read` + `persistent-memory.md` 参数自动改写兼容；测试夹具改用当前 `read_memory` 工具。 |
| Prompt/profile storage 兼容 | 删除 prompt/profile/shell prompt 从旧 `config/`、`prompt/`、`core/prompt/`、`shell/` 路径自动迁移到 `src/contexts/agent-profile/prompts/` 的逻辑和测试。 |
| ASR/TTS 旧配置 | 删除 ASR 旧配置路径回读；删除 TTS 旧内嵌 `api_preset` 字段解析、透传和 translation fallback；只使用 translation preset 的 `apiPresetName`。 |
| Env 旧键 | 删除 `AGENT_HEARTBEAT_START_PAUSED` 读取和写入清理逻辑，只维护 `AGENT_HEARTBEAT_PAUSED`。 |
| 测试夹具 | 删除或改名只验证旧迁移/旧命名/旧字段的测试；同步移除旧 temporary workspace Memorize induction 的 prompt/session 归档断言，保留当前 admin run-day 编排、cursor 和失败不提交行为测试。 |
| Shell 设置 | 删除 Admin UI 中未生效的 `rolloverHour` 输入框、保存校验和 shell settings 默认字段；`/admin/api/shell-settings` 保留为空配置保存接口。 |
| TTS Bailian 配置 | 删除 Bailian `mode` 的类型、配置解析、Admin schema、patch 校验、前端填值和测试断言；旧配置文件中的 `mode` 字段会被忽略。 |
