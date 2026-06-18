import type { LLMChatResult, LLMClient, LLMMessage, LLMStreamHandlers, LLMToolCall } from "./index.js";

export type LLMRequestAgentId = "chat" | "memorize" | string;

export type LLMRequestSenderInput = {
  agentId: LLMRequestAgentId;
  client?: LLMClient;
  messages: LLMMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  extraParams?: Record<string, unknown>;
  presetName?: string;
  toolNames: string[];
  toolVariables?: Record<string, unknown>;
  round: number;
  stream?: boolean;
  streamHandlers?: LLMStreamHandlers;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
};

export type LLMRequestSender = (input: LLMRequestSenderInput) => Promise<LLMChatResult>;

export type LLMToolLoopLimits = {
  maxRounds?: number;
  maxTotalToolCalls?: number;
  maxRepeatedToolCalls?: number;
};

export type LLMToolLoopControl = {
  sentMessage?: boolean;
  invalidateSession?: boolean;
  resetSession?: boolean;
  continueAfterReset?: boolean;
  reachedToolCallLimit?: boolean;
  yieldReturn?: boolean;
};

export type LLMToolLoopExecution = {
  message?: LLMMessage;
  messages?: LLMMessage[];
  control?: LLMToolLoopControl;
};

export type LLMToolLoopRoundRequest = Omit<LLMRequestSenderInput, "round" | "messages"> & {
  messages?: LLMMessage[];
};

export type LLMToolLoopStopReason = "completed" | "empty_messages" | "tool_limit" | "reset" | "invalidated" | "cancelled" | "yield_return";

export type LLMToolLoopResult = {
  messages: LLMMessage[];
  rounds: number;
  finalResult?: LLMChatResult;
  finalMessage: LLMMessage;
  stopReason: LLMToolLoopStopReason;
  sentMessage: boolean;
  invalidateSession: boolean;
  toolCallCount: number;
};

export type LLMToolLoopInput = {
  initialMessages: LLMMessage[];
  buildRequest(input: { round: number; messages: LLMMessage[] }): Promise<LLMToolLoopRoundRequest> | LLMToolLoopRoundRequest;
  sendRequest: LLMRequestSender;
  executeTool(call: LLMToolCall, context: {
    round: number;
    result: LLMChatResult;
    callIndex: number;
    reachedToolCallLimit: boolean;
  }): Promise<LLMToolLoopExecution> | LLMToolLoopExecution;
  beforeRound?(input: { round: number; messages: LLMMessage[] }): Promise<{ messages?: LLMMessage[]; stop?: boolean }> | { messages?: LLMMessage[]; stop?: boolean };
  beforeTool?(input: { round: number; call: LLMToolCall; callIndex: number }): Promise<void> | void;
  afterRequest?(input: { round: number; result: LLMChatResult; messages: LLMMessage[] }): Promise<void> | void;
  shouldCancel?(): boolean;
  onMessagesChanged?(input: { round: number; messages: LLMMessage[]; reason: "completed" | "tools" | "limit" }): Promise<void> | void;
  limits?: LLMToolLoopLimits;
};

export const defaultLLMToolLoopLimits: Required<LLMToolLoopLimits> = {
  maxRounds: 20,
  maxTotalToolCalls: 20,
  maxRepeatedToolCalls: 3
};

export async function runLLMToolLoop(input: LLMToolLoopInput): Promise<LLMToolLoopResult> {
  const limits = { ...defaultLLMToolLoopLimits, ...(input.limits ?? {}) };
  let messages = cloneLLMMessages(input.initialMessages);
  let previousToolCallSignature: string | undefined;
  let repeatedToolCallCount = 0;
  let totalToolCallCount = 0;
  let sentMessage = false;
  let invalidateSession = false;

  const cancelledResult = (rounds: number, finalResult?: LLMChatResult): LLMToolLoopResult => ({
    messages,
    rounds,
    finalResult,
    finalMessage: finalResult?.message ?? messages.at(-1) ?? { role: "assistant", content: "" },
    stopReason: "cancelled",
    sentMessage,
    invalidateSession,
    toolCallCount: totalToolCallCount
  });

  for (let round = 0; round < limits.maxRounds; round += 1) {
    if (input.shouldCancel?.()) return cancelledResult(round);
    const before = await input.beforeRound?.({ round, messages });
    if (before?.messages) messages = cloneLLMMessages(before.messages);
    if (before?.stop || messages.length === 0) {
      return {
        messages,
        rounds: round,
        finalMessage: messages.at(-1) ?? { role: "assistant", content: "" },
        stopReason: "empty_messages",
        sentMessage,
        invalidateSession,
        toolCallCount: totalToolCallCount
      };
    }

    const request = await input.buildRequest({ round, messages });
    let result: LLMChatResult;
    try {
      result = await input.sendRequest({
        ...request,
        round,
        messages: cloneLLMMessages(request.messages ?? messages)
      });
    } catch (error) {
      if (input.shouldCancel?.()) return cancelledResult(round + 1);
      throw error;
    }
    await input.afterRequest?.({ round, result, messages });
    if (input.shouldCancel?.()) return cancelledResult(round + 1, result);

    const calls = result.message.toolCalls ?? [];
    if (calls.length === 0) {
      messages = [
        ...messages,
        {
          role: "assistant",
          content: result.message.content,
          reasoningContent: result.message.reasoningContent
        }
      ];
      await input.onMessagesChanged?.({ round, messages, reason: "completed" });
      return {
        messages,
        rounds: round + 1,
        finalResult: result,
        finalMessage: result.message,
        stopReason: "completed",
        sentMessage,
        invalidateSession,
        toolCallCount: totalToolCallCount
      };
    }

    let reachedToolCallLimit = false;
    let resetSession = false;
    let continueAfterReset = false;
    let yieldReturn = false;
    const executedCalls: LLMToolCall[] = [];
    const toolMessages: LLMMessage[] = [];
    for (const [callIndex, call] of calls.entries()) {
      totalToolCallCount += 1;
      if (totalToolCallCount >= limits.maxTotalToolCalls) reachedToolCallLimit = true;
      const signature = toolCallSignature(call);
      if (signature === previousToolCallSignature) {
        repeatedToolCallCount += 1;
      } else {
        previousToolCallSignature = signature;
        repeatedToolCallCount = 1;
      }
      if (repeatedToolCallCount >= limits.maxRepeatedToolCalls) reachedToolCallLimit = true;

      if (input.shouldCancel?.()) return cancelledResult(round + 1, result);
      await input.beforeTool?.({ round, call, callIndex });
      if (input.shouldCancel?.()) return cancelledResult(round + 1, result);
      executedCalls.push(call);
      const execution = await input.executeTool(call, {
        round,
        result,
        callIndex,
        reachedToolCallLimit
      });
      if (execution.control?.yieldReturn !== true) {
        if (execution.message) toolMessages.push(execution.message);
        if (execution.messages) toolMessages.push(...cloneLLMMessages(execution.messages));
      }
      sentMessage = sentMessage || execution.control?.sentMessage === true;
      invalidateSession = invalidateSession || execution.control?.invalidateSession === true;
      resetSession = resetSession || execution.control?.resetSession === true;
      continueAfterReset = continueAfterReset || execution.control?.continueAfterReset === true;
      yieldReturn = yieldReturn || execution.control?.yieldReturn === true;
      reachedToolCallLimit = reachedToolCallLimit || execution.control?.reachedToolCallLimit === true;
      if (resetSession) break;
    }

    if (!resetSession) {
      messages = [
        ...messages,
        {
          role: "assistant",
          content: result.message.content,
          reasoningContent: result.message.reasoningContent ?? "",
          toolCalls: executedCalls
        },
        ...toolMessages
      ];
      await input.onMessagesChanged?.({
        round,
        messages,
        reason: reachedToolCallLimit || round + 1 >= limits.maxRounds ? "limit" : "tools"
      });
    }

    if (resetSession) {
      if (continueAfterReset && !reachedToolCallLimit && round + 1 < limits.maxRounds) continue;
      return {
        messages,
        rounds: round + 1,
        finalResult: result,
        finalMessage: result.message,
        stopReason: "reset",
        sentMessage,
        invalidateSession,
        toolCallCount: totalToolCallCount
      };
    }
    if (yieldReturn) {
      return {
        messages,
        rounds: round + 1,
        finalResult: result,
        finalMessage: result.message,
        stopReason: "yield_return",
        sentMessage,
        invalidateSession,
        toolCallCount: totalToolCallCount
      };
    }
    if (reachedToolCallLimit || round + 1 >= limits.maxRounds) {
      return {
        messages,
        rounds: round + 1,
        finalResult: result,
        finalMessage: result.message,
        stopReason: "tool_limit",
        sentMessage,
        invalidateSession,
        toolCallCount: totalToolCallCount
      };
    }
    if (invalidateSession) {
      return {
        messages,
        rounds: round + 1,
        finalResult: result,
        finalMessage: result.message,
        stopReason: "invalidated",
        sentMessage,
        invalidateSession,
        toolCallCount: totalToolCallCount
      };
    }
  }

  return {
    messages,
    rounds: limits.maxRounds,
    finalMessage: messages.at(-1) ?? { role: "assistant", content: "" },
    stopReason: "tool_limit",
    sentMessage,
    invalidateSession,
    toolCallCount: totalToolCallCount
  };
}

export function cloneLLMMessages(messages: LLMMessage[]): LLMMessage[] {
  return messages.map((message) => ({
    ...message,
    toolCalls: message.toolCalls?.map((call) => ({ ...call, function: { ...call.function } }))
  }));
}

function toolCallSignature(call: LLMToolCall): string {
  return `${call.function.name}:${stableJson(parseToolArguments(call.function.arguments))}`;
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
