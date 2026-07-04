# Agent Loop 运行边界

本文档只描述当前 loop 边界。平台入站、消息存储、TalkRuntime、ASR、TTS 和后台页面不属于 loop 模块。

## Chat Loop

Chat loop 的实现入口在 `src/contexts/agent-loop/src/application/run-chat-loop.ts`，运行时装配在 `src/contexts/agent-loop/src/runtime/chat-agent-runtime.ts`。

当前职责：

- 使用 `agentId: "chat"` 发起 LLM 请求。
- 维护聊天 LLM session 策略、token 压力处理、fixed-prefix append、`Yield` 恢复。
- 只执行请求构筑阶段暴露给模型的 tool call。
- 处理 `Chat` 工具的发送流式参数和 loop 终止语义。

Chat prompt profile 位于 `src/contexts/agent-profile/prompts/prompt-profile.json`，由后台 Prompt 页面编辑。

## Talk Loop

Talk loop 的实现入口在 `src/contexts/agent-loop/src/application/run-talk-loop.ts`。

当前职责：

- 使用 `agentId: "talk"` 发起 LLM 请求。
- 使用 Talk prompt profile 构筑实时对话请求。
- 从 TalkRuntime 构筑当前会话消息补丁。
- 复用统一 function-call loop 执行已暴露工具。

Talk prompt profile 位于 `src/contexts/agent-profile/prompts/talk-prompt-profile.json`，后台 Prompt 页面可独立编辑 Chat 和 Talk。

## Memorize

Memorize 不是 Chat/Talk loop 的一种。记忆归纳使用独立 prompt 与 API preset，入口在 memory 相关 context 中维护。

## 边界

Loop 只负责 LLM session 策略和 tool-call 执行流程。Tool 是否可用由 request 构筑阶段的可见工具决定；loop 执行期不按 loop kind、requester、channel 或 tool name 做二次拦截。
