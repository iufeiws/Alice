# promptContextRuntime 单一入口重构计划

## 目标

项目内所有 LLM-facing 文本渲染、变量取值、变量名列举只允许通过同一个 `promptContextRuntime` 进入：

- `renderText(content)`
- `getVariable(name)`
- `listVariables()`

`promptContextRuntime` 是进程内 app-scoped 只读单例：由 API bootstrap 创建一次，挂在 `apiContextRuntime.promptContextRuntime` 上，调用时直接从注入的 store、config、time provider、registry 读取最新值。

不得再保留或新增任何旁路变量构造入口，例如 `buildLLMTextVariables()`、局部 `LLMTextVariables` 快照、按模块自行拼装 user/time/profile/memory/dailyShell/calendar/library/skills 变量对象。

## 非目标

- 不新增 prompt 内容。
- 不新增兼容 fallback。
- 不保留旧 API 作为迁移缓冲。
- 不改变 prompt layer 顺序。
- 不让 preview 与实际发送路径使用不同解析逻辑。
- 不引入 per-turn runtime、临时 override、`setVariable()` 或全局 mutable map。
- 不把 talk 临时状态、Memorize 任务参数、tool input 伪装成全局 prompt 变量。

## 当前问题

`agent-profile/application/llm-text-renderer.ts` 目前承担了不该存在的旁路职责：

- `buildLLMTextVariables()` 物化一份运行时变量对象。
- `createLLMTextRenderer({ getVariable })` 在 `promptContextRuntime` 之外又形成一层渲染入口。
- `renderLLMText()` / `renderLLMValue()` / `formatToolResultForLLM()` 允许调用方绕过 `promptContextRuntime.renderText(content)`。

这些都和 `apiContextRuntime.promptContextRuntime` 语义重复，会诱导调用方绕过统一 runtime 自行构造变量快照或自行持有 renderer，导致实际 LLM 运行、preview、tool schema、tool result 之间再次分叉。

## 目标边界

- `src/contexts/prompt-context/` 是 prompt context runtime 的实现归属。
- `apps/api/bootstrap` 只负责创建并挂载 app-scoped `promptContextRuntime` 实例，不承载变量解析逻辑。
- `agent-profile/application/llm-text-renderer.ts` 删除。
- `agent-profile/src/ports/prompt-rendering.ts` 删除。
- 业务模块不得 import 或构造 `LLMTextVariables` 来服务 LLM-facing 文本。
- 需要渲染 tool description/schema/result message 的地方，必须拿到 `promptContextRuntime`。

## 新模块形状

新增 `src/contexts/prompt-context/`：

- `src/contexts/prompt-context/src/contracts/prompt-context-runtime.ts`
  - 定义 `PromptContextRuntime` / `PromptContextValue`。
  - `PromptContextRuntime` 只包含 `renderText`、`getVariable`、`listVariables`。

- `src/contexts/prompt-context/src/application/prompt-context-runtime.ts`
  - 实现 `createPromptContextRuntime(deps)`。
  - 保留现有变量读取语义：每次 `getVariable(name)` 直接读取注入的 store、config、time provider、skills registry。
  - `renderText(content)` 的 `{{name}}` 替换逻辑只能调用同一 runtime 的 `getVariable(name)`。
  - 不提供任何写入、override 或 per-turn 派生能力。

- `src/contexts/prompt-context/src/application/prompt-variable-tree.ts`
  - 实现 `promptVariableTree(runtime)`。
  - 只能使用 `runtime.listVariables()` 和 `runtime.getVariable(name)`。

## 迁移步骤

1. 建立 `contexts/prompt-context`
   - 从 `apps/api/bootstrap/prompt-context-runtime.ts` 迁出 `createPromptContextRuntime()` 实现。
   - 从 `agent-profile/application/llm-text-renderer.ts` 只迁出可保留的 `renderText(content)` 替换逻辑；不得迁出通用 value renderer 或 tool result formatter。
   - 删除所有变量对象 API：`buildLLMTextVariables()`、`createLLMTextVariableRenderer()`、`renderLLMText(content, variablesObject)`、`renderLLMValue(value, variablesObject)`、`formatToolResultForLLM(result, variablesObject)`。
   - 删除 `LLMTextRenderer` / `LLMTextValue` / `LLMTextVariables` 类型。

2. 收紧 bootstrap 职责
   - API bootstrap 从 `contexts/prompt-context` import `createPromptContextRuntime()`。
   - bootstrap 只负责传入 username、time、stores、calendar、skills、config path 等 deps。
   - `apiContextRuntime.promptContextRuntime` 继续作为全局运行时指针供下游使用。
   - 删除或清空 `src/apps/api/bootstrap/prompt-context-runtime.ts`；不保留同名 re-export 作为兼容层。

3. 删除旧边界
   - 删除 `src/contexts/agent-profile/src/application/llm-text-renderer.ts`。
   - 删除 `src/contexts/agent-profile/src/ports/prompt-rendering.ts`。
   - 检查所有 barrel export，禁止重新暴露变量对象构造能力。

4. 迁移调用点
   - 所有 `buildLLMTextVariables(...)` 调用改为从现有 runtime/context deps 获取 `promptContextRuntime`。
   - 所有 `renderLLMText(...)` 改为 `promptContextRuntime.renderText(...)`。
   - 所有 `renderLLMValue(...)` 调用按字段拆掉：只有明确 LLM-facing 的字符串字段才能调用 `promptContextRuntime.renderText(...)`。
   - 删除所有通用 tool result formatter；在唯一构造 LLM tool result message 的位置字段级处理字符串。
   - 所有类型引用改为 `PromptContextRuntime` / `PromptContextValue`。

5. 清理特殊模块
   - Memorize 不再通过 `buildLLMTextVariables()` 获得通用 `user/date/time/timezone/memory` 变量。
   - `promptContextRuntime` 不新增 `memorize/*` 字段。
   - 本重构不决定 Memorize 任务参数如何进入其自身 LLM request；只要求不能复用旧变量对象 renderer 作为旁路。
   - Skill instructions 不允许自行追加隐藏 `ARGUMENTS:`；若需要参数文本，必须作为显式变量或显式 tool result 内容处理。
   - Calendar、conversation recall、TTS/ASR/image generation 等非 Chat 路径，按是否 LLM-facing 区分：只要进入 LLM request 或 tool result，就走同一 runtime。

6. 统一 preview
   - Admin UI 不再在前端自行实现 `{{key}}` 替换。
   - preview 结果由后端使用同一个 `promptContextRuntime` 渲染后返回。
   - 前端只展示 unresolved marker，不负责解析变量。

7. 测试
   - 删除依赖旧 `llm-text-renderer.ts` API 的测试，或改成通过真实/测试版 `PromptContextRuntime` 断言。
   - 测试 helper 不得再构造变量对象 renderer；需要测试 runtime 时，直接提供 `{ renderText, getVariable, listVariables }`。
   - typecheck 必须发现任何旧 API 引用。
   - 增加或更新测试覆盖：
     - prompt layer 渲染只使用 runtime。
     - tool description/schema/result message 的 LLM-facing 字符串字段只使用 runtime。
     - prompt variable tree 来自 `listVariables()` + `getVariable(name)`。
     - preview 与实际 request 使用同一渲染入口。

## 逐文件修改清单

以下清单来自本轮逐文件 subagent 探索。未列出的文件是 no hit 或仅静态 JSON/profile 占位符，不需要为本重构修改。

### 新增 prompt-context

- `src/contexts/prompt-context/src/contracts/prompt-context-runtime.ts`
  - 新增 `PromptContextRuntime` / `PromptContextValue` 类型。

- `src/contexts/prompt-context/src/application/prompt-context-runtime.ts`
  - 从 `apps/api/bootstrap/prompt-context-runtime.ts` 迁入 `createPromptContextRuntime()`。
  - 保持现有变量读取行为不变。
  - `renderText(content)` 只能通过同一对象的 `getVariable(name)` 取值。

- `src/contexts/prompt-context/src/application/prompt-variable-tree.ts`
  - 迁入 `promptVariableTree(runtime)`。

- `src/contexts/prompt-context/src/index.ts`
  - 只导出新 runtime contract、factory 和 prompt variable tree。
  - 不导出任何变量对象 API。

### 删除旧入口

- `src/apps/api/bootstrap/prompt-context-runtime.ts`
  - 删除文件，或先迁空后删除。
  - 其他 bootstrap 文件直接 import `contexts/prompt-context`。

- `src/contexts/agent-profile/src/application/llm-text-renderer.ts`
  - 删除整个文件。

- `src/contexts/agent-profile/src/ports/prompt-rendering.ts`
  - 删除整个文件。

### Bootstrap / wiring

- `src/apps/api/bootstrap/api-context-runtime.ts`
  - 从 `contexts/prompt-context` import `createPromptContextRuntime()`。
  - 继续创建一次 `promptContextRuntime` 并挂到 `apiContextRuntime`。

- `src/apps/api/bootstrap/api-admin-runtime.ts`
  - `promptVariableTree` import 改到 `contexts/prompt-context`。

- `src/apps/api/bootstrap/admin-route-context.ts`
  - `LLMTextRenderer` / `LLMTextValue` 类型改为 `PromptContextRuntime` / `PromptContextValue`。

- `src/apps/api/bootstrap/admin-context-runtime.ts`
  - `getPromptRenderer()` 返回类型改为 `PromptContextRuntime`。

- `src/apps/api/bootstrap/api-agent-runtime.ts`
  - `getPromptRenderer()` 返回类型改为 `PromptContextRuntime`。

- `src/apps/api/bootstrap/voice-plugin-runtime.ts`
  - `promptContextRuntime` 类型改为 `PromptContextRuntime`。

- `src/channels/tts/src/types.ts`
  - `promptRenderer` 类型改为 `PromptContextRuntime | (() => PromptContextRuntime)`。

### Prompt layer / preview / admin

- `src/contexts/agent-profile/src/domain/prompt-layer.ts`
  - `renderer` 参数类型改为 `PromptContextRuntime`。
  - 继续只调用 `renderer.renderText(...)`，不得引入局部 renderer 或变量对象。

- `src/contexts/agent-profile/src/application/build-system-prompt.ts`
  - `PromptRenderContext.renderer` 类型改为 `PromptContextRuntime`。
  - 删除 `formatPromptToolResult()`；prompt tool result message 构造处按字段直接调用 `promptContextRuntime.renderText(...)`。
  - 删除对旧 `formatToolResultForLLM` 的 import。

- `src/contexts/agent-profile/src/application/prompt-tool-preview-runtime.ts`
  - `getPromptRenderer()` 和 `llmRequests.buildTools(...)` 参数类型改为 `PromptContextRuntime`。

- `src/contexts/agent-profile/src/application/admin-prompt-memory-runtime.ts`
  - 删除 `renderLLMValue(tool.description/inputSchema, renderer)`。
  - `tool.description` 如为字符串，直接调用 `promptContextRuntime.renderText(tool.description)`。
  - `tool.inputSchema` 只渲染 schema 中明确给 LLM 看的文本字段；不得深度递归扫描整个 schema。
  - tool result preview 不调用通用 formatter；预览 message 构造处按字段直接调用 `promptContextRuntime.renderText(...)`。

- `src/apps/api/admin-ui/tabs/initiated-behaviors-script.ts`
  - 删除前端 `renderPromptPreviewText` 的 `{{key}}` 替换实现。
  - 前端只展示后端返回的已渲染 preview 和 unresolved marker。

- `src/apps/api/bootstrap/admin-api-service.ts`
  - 所有 prompt/profile/tool preview delegate 确认只走后端 `promptContextRuntime`。
  - `getPromptVariableTree()` 继续只暴露 runtime tree，不暴露旧变量对象。

- `src/contexts/agent-profile/src/domain/shell.ts`
  - 删除 domain 内独立 `{{}}` 渲染器。
  - `dailyShell.rendered` 如仍需要，只能由持有 `promptContextRuntime` 的应用层生成；domain 层只保存 shell 原始字段。

- `src/contexts/agent-profile/src/application/shell-admin-runtime.ts`
  - `todayVariables` / shell preview 改为读取 `promptContextRuntime.listVariables/getVariable`，不调用 domain 内独立 renderer。

### LLM gateway / request / loop

- `src/contexts/llm-gateway/src/llm-requests.ts`
  - `buildTools()` / `buildToolsFromDefinitions()` 渲染参数改为 `PromptContextRuntime`。
  - 删除 `Record<string, unknown>` 变量对象参数。
  - 删除 `renderLLMValue` import。
  - `tool.description` 直接调用 `promptContextRuntime.renderText(tool.description)`。
  - `tool.inputSchema` 只渲染 schema 中明确给 LLM 看的文本字段；不得深度递归扫描整个 schema。
  - `extraParams` 不做通用模板渲染；如某个 extra param 字段确认是 LLM-facing prompt 文本，单独列名并调用 `renderText`。

- `src/contexts/llm-gateway/src/llm-tool-loop.ts`
  - `toolVariables` 类型改为 `PromptContextRuntime`。
  - 删除 `llmTextRenderer()` 兼容识别函数。
  - 删除 tool result 通用 formatter。
  - 在唯一构造 LLM tool result message 的位置处理：
    - `typeof output === "string"` 时调用 `promptContextRuntime.renderText(output)`。
    - `typeof error === "string"` 时调用 `promptContextRuntime.renderText(error)`。
    - object/array 输出只 `JSON.stringify(output)`，不做 prompt 渲染。

- `src/contexts/llm-gateway/src/llm-request-preview-runtime.ts`
  - preview request 构筑只从注入的 `PromptContextRuntime` 获取渲染能力。
  - 不构造任何变量对象。

- `src/contexts/llm-gateway/src/llm-message-sanitization.ts`
  - 保留 synthetic prompt tool call 的过滤逻辑。
  - 不新增 prompt 渲染逻辑；如果需要判断 prompt 区域，只读 session metadata。

- `src/contexts/llm-session/src/application/llm-session-runtime.ts`
  - `rewriteActiveTalkLLMSessionFromRuntime()` 的 `buildTalkRuntimeMessages()` 结果必须来自 talk runtime 持有的同一个 `PromptContextRuntime` 渲染路径。
  - 不在 session runtime 内自行渲染变量。

- `src/contexts/llm-session/src/application/llm-session-view.ts`
  - 保留 prompt 区域展示/过滤逻辑。
  - 不做 `{{}}` 替换；展示层只显示已保存 message。

- `src/contexts/agent-loop/src/application/run-chat-loop.ts`
  - `buildTextVariables(event)` 改名为 `getPromptContextRuntime(event)` 或等价命名，返回 app-scoped `PromptContextRuntime`。
  - `buildRequest()` 只传 `toolVariables: promptContextRuntime`。

- `src/contexts/agent-loop/src/application/run-talk-loop.ts`
  - `toolVariables` 类型改为 `PromptContextRuntime`。
  - `buildTalkAgentLoopState()` 返回同一个 runtime，不构造旧 renderer。

- `src/contexts/agent-loop/src/application/chat-agent.ts`
  - `LLMTextRenderer` 类型改为 `PromptContextRuntime`。
  - `buildTurnTextVariables()` 改名，返回 runtime。

- `src/contexts/agent-loop/src/application/chat-loop-session-context.ts`
  - 删除 `LLMTextVariables` 类型。
  - fake/prompt tool result message 构造处按字段直接调用 `promptContextRuntime.renderText(...)`，不保留通用 formatter。

- `src/contexts/agent-loop/src/application/talk-loop-session-context.ts`
  - `toolVariables` / `requirePromptRenderer()` 类型改为 `PromptContextRuntime`。

- `src/contexts/agent-loop/src/application/agent-loop-tool-executor.ts`
  - `variables` 类型改为 `PromptContextRuntime`。
  - 删除 `formatAgentLoopToolResultForLLM()`；由唯一 LLM tool result message 构造点字段级处理。

- `src/contexts/agent-loop/src/application/chat-loop-tool-control.ts`
  - 保留 fixed_prefix/static message 构造逻辑。
  - 不在这里做变量替换；若 tool result 字符串字段需要渲染，必须在唯一 LLM tool result message 构造点完成。

- `src/contexts/agent-loop/src/runtime/agent-loop-session-initializer.ts`
  - message patch 构造不得自行渲染变量。
  - 只消费已经通过 runtime 渲染完成的 prompt messages。

- `src/contexts/agent-loop/src/application/tool-followup-messages.ts`
  - `attachment.followupText` 进入 LLM 前如包含变量，必须通过 `PromptContextRuntime.renderText` 处理。
  - 不保留未声明的 fallback 文本渲染路径。

### Messaging / tools / capabilities

- `src/capabilities/tools/messaging/src/admin-shared.ts`
  - `LLMTextRenderer` 类型改为 `PromptContextRuntime`。
  - 删除对旧 tool result formatter 的依赖；admin preview message 构造处字段级处理。

- `src/capabilities/tools/messaging/src/admin-runtime.ts`
  - tool result preview 使用 `context.getPromptRenderer()` 返回的 `PromptContextRuntime`，但不调用通用 formatter。

- `src/capabilities/tools/messaging/src/index.ts`
  - `{{user}}` speaker placeholder 不再作为局部变量对象渲染。
  - chat/search/poll tool result 交给 loop/admin 的唯一 LLM tool result message 构造点按字段渲染。
  - shell/time 上下文如果仍要进入 tool result，先进入 `promptContextRuntime` 变量源。

- `src/capabilities/tools/messaging/profile.ts`
  - `appendCurrentTime()` 生成的 LLM-facing 时间文本改为从 `promptContextRuntime.getVariable("date_time")` 等读取，或改成普通 tool result 字符串字段后由唯一 LLM tool result message 构造点渲染。

- `src/capabilities/tools/bookcase/src/index.ts`
  - 删除 `renderLLMText` import。
  - `formatBookcaseInstructionBlock` / tool result 中的 `{{user}}` 改为 `promptContextRuntime.renderText(template)`。
  - bookcase 工具 runtime 需要拿到 `PromptContextRuntime`，不得传 `{ user: ... }`。

- `src/capabilities/tools/photo/src/selfie-tool.ts`
  - 删除 `buildLLMTextVariables` / `renderLLMText` import。
  - selfie prompt 模板只通过 `promptContextRuntime.renderText(template)` 渲染。
  - `pose` / tool input 不再作为隐藏 `{{pose}}` 变量旁路；需要进入 prompt 时必须成为显式 tool input 内容。

- `src/contexts/capabilities/src/outfit-on-body-runtime.ts`
  - 删除 `createLLMTextRenderer` 和本地 `outfit/*` override renderer。
  - on-body prompt 模板只通过 `promptContextRuntime.renderText(template)` 渲染。
  - 如果需要渲染非当日 outfit，必须先确认它是否应成为 Prompt 编辑器可见变量；未经确认不得加入 runtime 变量源。

- `src/contexts/capabilities/src/admin-plugin-runtime.ts`
  - `translateTtsText` 依赖继续传 `PromptContextRuntime`。
  - 不允许插件 runtime 构造自己的 renderer。

- `src/capabilities/tools/calendar/src/calendar-context.ts`
  - `buildCalendarContext()` 生成的 `<calendar>` 如果用于 prompt 变量，迁入 `promptContextRuntime.getVariable("calendar/context")` 的实现或其 provider。
  - 工具内保留业务查询格式可以，但不能作为 prompt 变量旁路。

- `src/capabilities/tools/calendar/src/index.ts`
  - `listEntries` / `renderDay` 的 LLM-facing result 交给唯一 LLM tool result message 构造点按字段渲染。
  - 不在工具内自行承担 prompt context provider 职责。

- `src/contexts/conversation-hub/src/adapters/sqlite-conversation-store.ts`
  - `formatContextLine()` / `summarizeReactions()` 如果服务于 LLM recall/read context，迁到 `promptContextRuntime` 的 conversation provider 或调用方明确字段级 formatter。
  - store 层只返回结构化消息，不拼 LLM-facing 上下文行。

- `src/capabilities/tools/skills/src/index.ts`
  - `formatSkillResult()` 不再把 `skill.instructions` 直接拼成 LLM tool result。
  - Skill instructions 如必须进入 LLM，走 `promptContextRuntime.renderText` 后作为明确 tool result 字段。

- `src/contexts/skills/src/registry.ts`
  - `formatAvailableSkillsXml()` 只能被 `promptContextRuntime.getVariable("available_skills")` 调用。
  - 其他模块不得直接调用它生成 prompt 文本。

- `src/contexts/skills/src/loader.ts`
  - 删除 `$ARGUMENTS` / `$0` 的独立渲染入口。
  - 删除无 placeholder 时追加 `ARGUMENTS: ${args}` 的行为。
  - Skill 参数如果需要给 LLM，必须作为显式变量或 tool result 字段，由 `promptContextRuntime.renderText` 统一渲染。

### Memory / Memorize

- `src/contexts/memory/src/index.ts`
  - 删除 `createLLMTextVariableRenderer` / `buildLLMTextVariables` / `LLMTextVariables` import。
  - workspace 和 single-target prompt layer 渲染改为使用注入的 `PromptContextRuntime`。
  - `memoryPromptVariables()` 删除；通用 `user/date/time/timezone/memory/wakeBoundary/calendar` 从 `promptContextRuntime` 读。
  - `promptContextRuntime` 不新增 `memorize/*` 字段。
  - 本重构不决定 Memorize 任务参数如何进入其自身 LLM request；只要求不能复用旧变量对象 renderer 作为旁路。
  - fake `Read` / `self_talk` tool result 交给唯一 LLM tool result message 构造点字段级处理。

- `src/contexts/memory/src/application/admin-memory-runtime.ts`
  - `previewPrompts()` 和 `runMemoryInductionForMessages()` 传入 `PromptContextRuntime`。
  - 不在 admin memory runtime 内组变量对象。

- `src/contexts/memory/src/application/induce-memory.ts`
  - memory induction request 构筑只用 `PromptContextRuntime` 渲染已有 prompt 内容。

- `src/contexts/memory/src/application/manage-memory-llm-session.ts`
  - `buildTalkRuntimeMessages()` 重写 session messages 时，只消费 runtime 渲染后的消息。

- `src/contexts/memory/src/application/profile-memory.ts`
  - `formatPreviewContextLine()` 如服务 prompt preview，改为后端 runtime/provider 统一生成。

- `src/contexts/memory/src/application/sleep-memory-bridge.ts`
  - 只透传 `PromptContextRuntime`，不传 prompt store 后自行组变量。

### TTS / ASR / Image generation / voice

- `src/channels/tts/src/config.ts`
  - `renderTtsPrompt()` 参数改为 `PromptContextRuntime`。
  - 只调用 `runtime.renderText(config.prompt.trim())`。

- `src/channels/tts/src/translation.ts`
  - translation LLM request 的 system prompt 来自 `PromptContextRuntime.renderText(...)`。
  - 不在 translation 层构造变量。

- `src/channels/tts/src/conversion.ts`
  - `mimoTtsMessages()` 构造 chat-completions messages 时，所有配置 prompt 先走 `PromptContextRuntime.renderText`。

- `src/channels/asr/src/index.ts`
  - multimodal ASR prompt 构筑改为接收 `PromptContextRuntime`。
  - `prompt` 进入 LLM request 前统一 `runtime.renderText(prompt)`。

- `src/channels/image-generation/src/codex-provider.ts`
  - `input.prompt` / `input.codexExtraPrompt` 进入 runner 前如包含变量，必须由调用方通过 `PromptContextRuntime.renderText` 渲染完成。
  - provider 不接受变量对象，也不拼 hidden prompt。

- `src/capabilities/skills/external/alice-selfie-fast/scripts/run-alice-selfie-fast.mjs`
  - 删除 `extraPrompt + prompt` 的隐式拼接职责，或要求输入已经是上游通过 `PromptContextRuntime.renderText` 得到的完整显式 prompt。
  - 不在 runner 脚本里追加隐藏 prompt。

- `src/channels/webrtc-voice/src/interrupt-controller.ts`
  - `breakpointContext` 如果进入 talk prompt，必须作为显式上下文内容处理，不进入全局 prompt 变量源。
  - 本文件只负责采集断点，不负责拼 prompt。

- `src/channels/webrtc-voice/src/playback-consumer.ts`
  - `playbackTextBeforeBreakpoint()` 只返回结构化断点数据。
  - 不生成 LLM-facing 文本。

- `src/contexts/talk-session/src/application/talk-session-runtime.ts`
  - `buildNextLoopMessagePatch()` 构造 message patch 时，所有模板化文本必须已经由 `PromptContextRuntime.renderText` 处理。
  - `noSpeechUserMessage` 如果是固定 LLM-facing 文本，必须确认是否属于可编辑 prompt；未经确认不得保留隐藏追加。

### 低风险但需要改类型或确认无旁路

- `src/apps/api/bootstrap/api-agent-stack-runtime.ts`
  - 仅透传 prompt runtime；类型改为 `PromptContextRuntime`。

- `src/apps/api/bootstrap/api-capabilities-runtime.ts`
  - 注入 capabilities runtime 的 prompt 参数类型改为 `PromptContextRuntime`。

- `src/apps/api/bootstrap/api-support-runtime.ts`
  - preview/support runtime wiring 保持透传 `PromptContextRuntime`。

- `src/apps/api/bootstrap/api-tooling-runtime.ts`
  - prompt preview / tool specs 相关依赖类型改为 `PromptContextRuntime`。

- `src/contexts/talk-session/src/runtime/talk-session-runtime.ts`
  - `getPromptRenderer()` 类型改为 `PromptContextRuntime`。

### 测试文件

- `tests/contexts/agent-profile/text-renderer-render-variable.test.ts`
  - 删除或重写为 `promptContextRuntime` 测试。
  - 不再测试 `buildLLMTextVariables` / `renderLLMText` / `createLLMTextVariableRenderer`。

- `tests/contexts/agent-profile/text-renderer-tool-result.test.ts`
  - 删除或改为测试唯一 LLM tool result message 构造点的字段级渲染。

- `tests/contexts/agent-profile/prompt-profile-helpers.ts`
  - helper 改为构造测试版 `PromptContextRuntime`。

- `tests/contexts/agent-loop/*helpers*.ts` 和 `tests/contexts/agent-loop/agent-tools*.test.ts`
  - 删除 `buildLLMTextVariables` / `createLLMTextVariableRenderer` import。
  - 测试 helper 直接提供 `{ renderText, getVariable, listVariables }`。

- `tests/contexts/initiative/initiated-behaviors-helpers.ts`
  - 改为测试版 `PromptContextRuntime`。

- `tests/capabilities/tools/messaging/messaging-tools*.test.ts`
  - 删除 `formatToolResultForLLM` import；如需覆盖 LLM-facing result 文本，测试唯一 LLM tool result message 构造点。

- `tests/contexts/agent-run-indicator/agent-run-indicator-helpers.ts`
  - 删除 `createLLMTextVariableRenderer`，改为测试版 `PromptContextRuntime`。

## 完成标准

- `rg "buildLLMTextVariables|createLLMTextVariableRenderer|LLMTextVariables|LLMTextRenderer|LLMTextValue" src tests docs` 无命中。
- `rg "llm-text-renderer|prompt-rendering" src tests docs` 无命中。
- `rg "renderLLMText|renderLLMValue|formatToolResultForLLM" src tests docs` 无旧 API 命中。
- `rg "formatPromptToolResult|formatAgentLoopToolResultForLLM|tool-result-formatting" src tests docs` 无命中。
- `rg "Record<string, unknown> \\| PromptContextRuntime|PromptContextRuntime \\| Record<string, unknown>" src` 无命中。
- `rg "renderPromptValue|render-prompt-value" src tests docs` 无命中。
- `rg "renderPromptObject|renderPromptSchema|renderPromptDeep|deepRenderPrompt" src tests docs` 无命中。
- LLM-facing 文本渲染只出现三类变量入口：
  - `promptContextRuntime.renderText(content)`
  - `promptContextRuntime.getVariable(name)`
  - `promptContextRuntime.listVariables()`
- 不存在 `promptContextRuntime.set*`、`withPromptContext`、override map 或 per-turn runtime 构造。
- `npm run typecheck` 通过。
- `npm test` 中相关 prompt/tool/preview 测试通过。
