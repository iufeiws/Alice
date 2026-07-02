import type { LLMChatInput, LLMChatResult, LLMToolCall } from "../../../llm-gateway/src/index.js";
import type { ToolResult } from "../contracts/agent-contracts.js";
import type { AgentFunctionCallToolExecution } from "../runtime/agent-loop-runtime.js";
import type { ChatAgentLoopSession, ChatAgentModeState } from "./run-chat-loop.js";

const fixedPrefixDefaultTtlMs = 2 * 60 * 60 * 1000;

export type ChatLoopToolControlInput = {
  call: LLMToolCall;
  toolInput: Record<string, unknown>;
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
    sentMessage: isSendChatToolCall(input.call.function.name, input.toolInput) && input.toolResult.ok,
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
    clearFixedPrefixState(input.session);
    return {
      message: input.toolMessage,
      control: {
        ...control,
        invalidateSession: false
      }
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
    reasoningContent: result.message.reasoningContent,
    toolCalls: [call]
  };
}

function defaultChatAgentModeState(): ChatAgentModeState {
  return { mode: "normal", modeStaticMessages: [], modeStaticTokenEstimate: 0, tokenPressurePreviewBaselines: {} };
}

function clearFixedPrefixState(session: ChatAgentLoopSession & Partial<ChatAgentModeState>): void {
  const mode = defaultChatAgentModeState();
  session.mode = mode.mode;
  session.modeStaticMessages = cloneLLMMessages(mode.modeStaticMessages);
  session.modeStaticTokenEstimate = mode.modeStaticTokenEstimate;
  session.tokenPressurePreviewBaselines = {};
  session.modeStartedAt = undefined;
  session.modeExpiresAt = undefined;
  session.fixedPrefixKind = undefined;
  session.fixedPrefixCursorMessageId = undefined;
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

function isSendChatToolCall(toolName: string, input: Record<string, unknown>): boolean {
  return toolName === "Chat" && input.action === "send";
}
