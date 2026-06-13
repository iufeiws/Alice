import type { LLMChatInput, LLMChatResult, LLMToolCall } from "../../../llm-gateway/src/index.js";
import type { ToolResult } from "../contracts/agent-contracts.js";
import type { AgentFunctionCallToolExecution } from "../runtime/agent-loop-runtime.js";
import type { ChatAgentLoopSession, ChatAgentModeState } from "./run-chat-loop.js";

const fixedPrefixDefaultTtlMs = 2 * 60 * 60 * 1000;

export type ChatLoopToolControlInput = {
  call: LLMToolCall;
  toolResult: ToolResult;
  toolMessage: NonNullable<AgentFunctionCallToolExecution["message"]>;
  session: ChatAgentLoopSession;
  llmResult: LLMChatResult;
  nowMs: number;
  lastCheckChatCursorMessageId?: number;
};

export type ChatLoopToolControlResult = AgentFunctionCallToolExecution & {
  modeState?: ChatAgentModeState;
  sessionRebuilt?: boolean;
};

export function resolveChatLoopToolControl(input: ChatLoopToolControlInput): ChatLoopToolControlResult {
  const control = {
    sentMessage: isSendChatToolName(input.call.function.name) && input.toolResult.ok,
    invalidateSession: input.toolResult.invalidateLLMSession === true,
    yieldReturn: input.toolResult.meta?.yieldReturn === true,
    resetSession: false,
    continueAfterReset: false
  };
  if (!input.toolResult.resetLLMSession) {
    return {
      message: input.toolMessage,
      control
    };
  }
  if (input.toolResult.clearFixedPrefix) {
    return {
      message: input.toolMessage,
      control: {
        ...control,
        resetSession: true,
        continueAfterReset: false,
        invalidateSession: true
      },
      modeState: defaultChatAgentModeState()
    };
  }

  const fixedPrefixKind = typeof input.toolResult.fixedPrefixKind === "string" && input.toolResult.fixedPrefixKind
    ? input.toolResult.fixedPrefixKind
    : undefined;
  const mode = fixedPrefixKind ? "fixed_prefix" : input.toolResult.llmSessionMode || "normal";
  const modeStaticMessages = resolveModeStaticMessages({
    mode,
    session: input.session,
    llmResult: input.llmResult,
    call: input.call,
    toolMessage: input.toolMessage,
    toolResult: input.toolResult
  });
  const modeStartedAt = mode === "normal" ? undefined : input.nowMs;
  const ttlMs = Number.isFinite(input.toolResult.fixedPrefixTtlMs)
    ? Number(input.toolResult.fixedPrefixTtlMs)
    : fixedPrefixDefaultTtlMs;
  const shouldContinueAfterReset = mode === "fixed_prefix" || mode !== "normal";
  return {
    message: input.toolMessage,
    control: {
      ...control,
      resetSession: true,
      continueAfterReset: shouldContinueAfterReset,
      invalidateSession: control.invalidateSession || mode === "normal"
    },
    modeState: {
      mode,
      modeStaticMessages,
      modeStaticTokenEstimate: estimateMessagesTokens(modeStaticMessages),
      tokenPressurePreviewBaselines: {},
      modeStartedAt,
      modeExpiresAt: mode === "fixed_prefix" && typeof modeStartedAt === "number" ? modeStartedAt + ttlMs : undefined,
      fixedPrefixKind,
      fixedPrefixCursorMessageId: mode === "fixed_prefix" ? input.lastCheckChatCursorMessageId : undefined
    },
    sessionRebuilt: shouldContinueAfterReset
  };
}

function resolveModeStaticMessages(input: {
  mode: string;
  session: ChatAgentLoopSession;
  llmResult: LLMChatResult;
  call: LLMToolCall;
  toolMessage: NonNullable<AgentFunctionCallToolExecution["message"]>;
  toolResult: ToolResult;
}): LLMChatInput["messages"] {
  if (input.mode === "fixed_prefix") {
    return [
      ...cloneLLMMessages(input.session.messages),
      toolRequestMessage(input.llmResult, input.call),
      input.toolMessage
    ];
  }
  if (input.mode === "normal") return [];
  return cloneLLMMessages((input.toolResult.llmSessionStaticMessages as LLMChatInput["messages"] | undefined) ?? [
    toolRequestMessage(input.llmResult, input.call),
    input.toolMessage
  ]);
}

function toolRequestMessage(result: LLMChatResult, call: LLMToolCall): LLMChatInput["messages"][number] {
  return {
    role: "assistant",
    content: result.message.content,
    reasoningContent: reasoningContentForToolRequest(result.message.reasoningContent, 1),
    toolCalls: [call]
  };
}

function defaultChatAgentModeState(): ChatAgentModeState {
  return { mode: "normal", modeStaticMessages: [], modeStaticTokenEstimate: 0, tokenPressurePreviewBaselines: {} };
}

function cloneLLMMessages(messages: LLMChatInput["messages"]): LLMChatInput["messages"] {
  return messages.map((message) => ({
    ...message,
    toolCalls: message.toolCalls?.map((call) => ({ ...call, function: { ...call.function } }))
  }));
}

function estimateMessagesTokens(messages: LLMChatInput["messages"]): number {
  return estimateTextTokens(messages.map((message) => [
    message.role,
    message.content,
    message.reasoningContent ?? "",
    message.name ?? "",
    message.toolCallId ?? "",
    JSON.stringify(message.toolCalls ?? [])
  ].join("\n")).join("\n"));
}

function estimateTextTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    tokens += /[\u4e00-\u9fff]/.test(char) ? 0.6 : 0.3;
  }
  return Math.round(tokens);
}

function reasoningContentForToolRequest(reasoningContent: string | undefined, toolCallCount: number): string | undefined {
  if (reasoningContent) return reasoningContent;
  return toolCallCount > 0 ? "Need to call the requested tool." : undefined;
}

function isSendChatToolName(toolName: string): boolean {
  return toolName === "send_chat" || toolName === "send_feishu" || toolName === "send_wechat" || toolName === "send_message";
}
