# Prompt Context Runtime 架构

Prompt context runtime 是 prompt variable 的当前读取边界，位于 API context 装配层。

## 目标边界

- prompt layer 解析保持纯函数，只消费 renderer。
- 运行时上下文由 API context 提供。
- 变量按名称即时读取，不为了渲染一次性构筑整棵变量树。
- Prompt Preview 和实际 LLM request 使用同一套 renderer。
- 不在运行时隐藏拼接 Core、Memorize 或主动行为 prompt。

## 当前输入

Prompt context runtime 读取的上下文包括：

- 当前时间。
- `config.project.username`。
- daily shell。
- core profile appearance。
- library setting。
- memory snapshot。
- wake boundary。
- calendar context。
- available skills。

## 使用方

当前使用方包括：

- Chat prompt 渲染。
- Talk prompt 渲染。
- Prompt preview。
- Tool preview。
- TTS 等需要显式 renderer 的文案渲染。

## 解析边界

`src/contexts/agent-profile/src/domain/prompt-layer.ts` 是 prompt layer 公共解析入口。Core、Memorize、主动行为和其它模块不得复制 normalize layer、layer 到 LLM message、tool argument 解析逻辑。

## 未落地差异

历史计划中提到的 `wakeBoundary.yesterday/today/tomorrow` 变量尚未完整落地。判断当前变量集合时以 `src/apps/api/bootstrap/prompt-context-runtime.ts` 为准。
