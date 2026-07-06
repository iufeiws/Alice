import type { LLMMessage } from "./index.js";

export type LLMMessageSanitizationOptions = {
  removeEmptyAssistantToolCalls?: boolean;
  removeAssistantReasoningWithoutToolCall?: boolean;
  removeParenthesizedAssistantResponseContent?: boolean;
  mergeConsecutiveAssistantContent?: boolean;
};

export const defaultLLMMessageSanitizationOptions: Required<LLMMessageSanitizationOptions> = {
  removeEmptyAssistantToolCalls: true,
  removeAssistantReasoningWithoutToolCall: true,
  removeParenthesizedAssistantResponseContent: true,
  mergeConsecutiveAssistantContent: true
};

export function sanitizeLLMRequestMessages(
  messages: LLMMessage[],
  options: LLMMessageSanitizationOptions = {}
): LLMMessage[] {
  const resolved = { ...defaultLLMMessageSanitizationOptions, ...options };
  const sanitized = messages.map((message) => {
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
      && (!sanitized.toolCalls || sanitized.toolCalls.length === 0)
    ) {
      delete sanitized.reasoningContent;
    }
    return sanitized;
  });
  return resolved.mergeConsecutiveAssistantContent ? mergeConsecutiveAssistantContent(sanitized) : sanitized;
}

export function sanitizeLLMResponseMessage(
  message: LLMMessage,
  options: LLMMessageSanitizationOptions = {}
): LLMMessage {
  const resolved = { ...defaultLLMMessageSanitizationOptions, ...options };
  if (!resolved.removeParenthesizedAssistantResponseContent || message.role !== "assistant") {
    return cloneLLMMessage(message);
  }
  return {
    ...cloneLLMMessage(message),
    content: typeof message.content === "string" ? stripParenthesizedContent(message.content) : message.content
  };
}

export function stripParenthesizedContent(content: string): string {
  const stripper = createParenthesizedContentStripper();
  return stripper.push(content);
}

export function createParenthesizedContentStripper() {
  let depth = 0;
  return {
    push(content: string): string {
      let result = "";
      for (const char of content) {
        if (isOpeningParenthesis(char)) {
          depth += 1;
          continue;
        }
        if (isClosingParenthesis(char)) {
          if (depth > 0) {
            depth -= 1;
            continue;
          }
          result += char;
          continue;
        }
        if (depth > 0) continue;
        result += char;
      }
      return result;
    }
  };
}

function cloneLLMMessage(message: LLMMessage): LLMMessage {
  return {
    ...message,
    toolCalls: message.toolCalls?.map((call) => ({ ...call, function: { ...call.function } }))
  };
}

function mergeConsecutiveAssistantContent(messages: LLMMessage[]): LLMMessage[] {
  const result: LLMMessage[] = [];
  for (const message of messages) {
    const previous = result.at(-1);
    if (previous && canMergeAssistantContent(previous) && canMergeAssistantContent(message)) {
      previous.content = `${previous.content}\n${message.content}`;
      continue;
    }
    result.push(message);
  }
  return result;
}

function canMergeAssistantContent(message: LLMMessage): boolean {
  return message.role === "assistant"
    && typeof message.content === "string"
    && (!message.toolCalls || message.toolCalls.length === 0)
    && message.reasoningContent === undefined
    && message.name === undefined
    && message.toolCallId === undefined;
}

function isOpeningParenthesis(char: string): boolean {
  return char === "(" || char === "（";
}

function isClosingParenthesis(char: string): boolean {
  return char === ")" || char === "）";
}
