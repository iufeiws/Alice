import type { LLMMessage } from "./index.js";

export type LLMMessageSanitizationOptions = {
  removeEmptyAssistantToolCalls?: boolean;
  removeAssistantReasoningWithoutToolCall?: boolean;
};

export const defaultLLMMessageSanitizationOptions: Required<LLMMessageSanitizationOptions> = {
  removeEmptyAssistantToolCalls: true,
  removeAssistantReasoningWithoutToolCall: true
};

export function sanitizeLLMRequestMessages(
  messages: LLMMessage[],
  options: LLMMessageSanitizationOptions = {}
): LLMMessage[] {
  const resolved = { ...defaultLLMMessageSanitizationOptions, ...options };
  return messages.map((message) => {
    const sanitized: LLMMessage = {
      ...message,
      toolCalls: message.toolCalls?.map((call) => ({ ...call, function: { ...call.function } }))
    };
    if (
      resolved.removeEmptyAssistantToolCalls
      && sanitized.role === "assistant"
      && Array.isArray(sanitized.toolCalls)
      && sanitized.toolCalls.length === 0
    ) {
      delete sanitized.toolCalls;
    }
    if (
      resolved.removeAssistantReasoningWithoutToolCall
      && sanitized.role === "assistant"
      && !hasAssistantFunctionCall(sanitized)
    ) {
      delete sanitized.reasoningContent;
    }
    return sanitized;
  });
}

function hasAssistantFunctionCall(message: LLMMessage): boolean {
  if (message.toolCalls && message.toolCalls.length > 0) return true;
  const extra = message as LLMMessage & {
    functionCall?: unknown;
    function_call?: unknown;
  };
  return extra.functionCall !== undefined || extra.function_call !== undefined;
}
