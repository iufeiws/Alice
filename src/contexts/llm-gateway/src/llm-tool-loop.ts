import type { LLMChatResult, LLMClient, LLMMessage, LLMStreamHandlers, LLMToolCall } from "./index.js";
import type { AgentEvent, ToolCall, ToolDefinition, ToolExecutionContext, ToolPlugin, ToolResult } from "../../agent-loop/src/contracts/agent-contracts.js";
import { normalizePromptProfile, type PromptProfile } from "../../agent-profile/src/application/build-system-prompt.js";
import { promptLayerToMessage } from "../../agent-profile/src/domain/prompt-layer.js";
import type { PromptContextRuntime } from "../../prompt-context/src/index.js";

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
  inlineTools?: ToolDefinition[];
  toolVariables?: PromptContextRuntime;
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
};

export type LLMToolLoopControl = {
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

export type LLMToolLoopAssistantMessageTransform = LLMMessage | {
  message: LLMMessage;
  completeAfterToolCalls?: boolean;
};

export type LLMToolLoopStopReason = "completed" | "empty_messages" | "tool_limit" | "reset" | "invalidated" | "cancelled" | "yield_return";

export type LLMToolLoopResult = {
  messages: LLMMessage[];
  rounds: number;
  finalResult?: LLMChatResult;
  finalMessage: LLMMessage;
  stopReason: LLMToolLoopStopReason;
  invalidateSession: boolean;
  toolCallCount: number;
};

export type LLMToolLoopInput = {
  initialMessages: LLMMessage[];
  buildRequest(input: { round: number; messages: LLMMessage[] }): Promise<LLMToolLoopRoundRequest> | LLMToolLoopRoundRequest;
  sendRequest: LLMRequestSender;
  toolRegistryName?: string;
  toolCallSource?: {
    requester?: AgentEvent["source"];
    externalSession?: AgentEvent["externalSession"];
  };
  buildToolExecutionContext?(input: {
    round: number;
    call: LLMToolCall;
    callIndex: number;
  }): ToolExecutionContext;
  transformAssistantMessage?(input: { round: number; message: LLMMessage }): LLMToolLoopAssistantMessageTransform;
  transformToolInput?(toolName: string, input: Record<string, unknown>): Record<string, unknown>;
  afterToolResult?(input: {
    round: number;
    result: LLMChatResult;
    call: LLMToolCall;
    callIndex: number;
    reachedToolCallLimit: boolean;
    toolInput: Record<string, unknown>;
    toolResult: ToolResult;
    toolMessage: NonNullable<LLMToolLoopExecution["message"]>;
  }): Promise<LLMToolLoopExecution | undefined> | LLMToolLoopExecution | undefined;
  beforeRound?(input: { round: number; messages: LLMMessage[] }): Promise<{ messages?: LLMMessage[]; stop?: boolean }> | { messages?: LLMMessage[]; stop?: boolean };
  beforeTool?(input: { round: number; call: LLMToolCall; callIndex: number }): Promise<void> | void;
  afterRequest?(input: { round: number; result: LLMChatResult; messages: LLMMessage[] }): Promise<void> | void;
  shouldCancel?(): boolean;
  promptProfile?: PromptProfile;
  runtimeInterrupts?: {
    hasPendingUserMessage(): boolean;
    consumePendingUserMessage(): boolean;
  };
  buildYieldResumeMessages?(input: {
    round: number;
    messages: LLMMessage[];
    result: LLMChatResult;
  }): Promise<LLMMessage[]> | LLMMessage[];
  onMessagesChanged?(input: { round: number; messages: LLMMessage[]; reason: "completed" | "tools" | "limit" }): Promise<void> | void;
  limits?: LLMToolLoopLimits;
};

const defaultToolRegistryName = "default";
const toolRegistries = new Map<string, Map<string, ToolPlugin>>();

export function registerLLMToolLoopTools(name: string, plugins: readonly ToolPlugin[]): () => void {
  const registry = buildToolPluginMap(plugins);
  toolRegistries.set(name, registry);
  return () => {
    if (toolRegistries.get(name) === registry) toolRegistries.delete(name);
  };
}

export function executeRegisteredLLMTool(
  registryName: string,
  call: ToolCall,
  context?: ToolExecutionContext
): Promise<ToolResult> {
  return toolPluginForCall(registryName, call.toolName).execute(call, context);
}

export const defaultLLMToolLoopLimits: Required<LLMToolLoopLimits> = {
  maxRounds: 100,
  maxTotalToolCalls: 100
};

export async function runLLMToolLoop(input: LLMToolLoopInput): Promise<LLMToolLoopResult> {
  const limits = { ...defaultLLMToolLoopLimits, ...(input.limits ?? {}) };
  let messages = cloneLLMMessages(input.initialMessages);
  let previousAssistantMessageSignature: string | undefined;
  let totalToolCallCount = 0;
  let replyToolCallCount = 0;
  let invalidateSession = false;
  let round = 0;
  let replyRound = 0;

  const cancelledResult = (rounds: number, finalResult?: LLMChatResult): LLMToolLoopResult => ({
    messages,
    rounds,
    finalResult,
    finalMessage: finalResult?.message ?? messages.at(-1) ?? { role: "assistant", content: "" },
    stopReason: "cancelled",
    invalidateSession,
    toolCallCount: totalToolCallCount
  });

  for (; replyRound < limits.maxRounds; round += 1, replyRound += 1) {
    if (input.shouldCancel?.()) return cancelledResult(round);
    const before = await input.beforeRound?.({ round, messages });
    if (before?.messages) messages = cloneLLMMessages(before.messages);
    if (before?.stop || messages.length === 0) {
      return {
        messages,
        rounds: round,
        finalMessage: messages.at(-1) ?? { role: "assistant", content: "" },
        stopReason: "empty_messages",
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
    const transformed = input.transformAssistantMessage?.({ round, message: result.message });
    const transformedMessage = isAssistantMessageTransformResult(transformed) ? transformed.message : transformed ?? result.message;
    const completeAfterToolCalls = isAssistantMessageTransformResult(transformed) && transformed.completeAfterToolCalls === true;
    result = transformedMessage === result.message ? result : { ...result, message: transformedMessage };
    const assistantMessageSignature = assistantLoopMessageSignature(result.message);
    if (assistantMessageSignature === previousAssistantMessageSignature) {
      throw new Error("llm_tool_loop_repeated_assistant_message");
    }
    previousAssistantMessageSignature = assistantMessageSignature;
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
      replyToolCallCount += 1;
      if (replyToolCallCount >= limits.maxTotalToolCalls) reachedToolCallLimit = true;

      if (input.shouldCancel?.()) return cancelledResult(round + 1, result);
      await input.beforeTool?.({ round, call, callIndex });
      if (input.shouldCancel?.()) return cancelledResult(round + 1, result);
      executedCalls.push(call);
      const execution = await executeTool(input, call, request, {
        round,
        result,
        callIndex,
        reachedToolCallLimit
      });
      if (execution.control?.yieldReturn !== true) {
        if (execution.message) toolMessages.push(execution.message);
        if (execution.messages) toolMessages.push(...cloneLLMMessages(execution.messages));
      }
      invalidateSession = invalidateSession || execution.control?.invalidateSession === true;
      resetSession = resetSession || execution.control?.resetSession === true;
      continueAfterReset = continueAfterReset || execution.control?.continueAfterReset === true;
      yieldReturn = yieldReturn || execution.control?.yieldReturn === true;
      reachedToolCallLimit = reachedToolCallLimit || execution.control?.reachedToolCallLimit === true;
      if (resetSession) break;
    }

    if (!resetSession) {
      const interruptMessages = !yieldReturn && !invalidateSession
        ? consumePendingUserMessageInterruptMessages(input, request)
        : [];
      const replyBudgetRenewed = interruptMessages.length > 0;
      if (replyBudgetRenewed) {
        replyRound = -1;
        replyToolCallCount = 0;
        reachedToolCallLimit = false;
        previousAssistantMessageSignature = undefined;
      }
      messages = [
        ...messages,
        {
          role: "assistant",
          content: result.message.content,
          reasoningContent: result.message.reasoningContent ?? "",
          toolCalls: executedCalls
        },
        ...toolMessages,
        ...interruptMessages
      ];
      await input.onMessagesChanged?.({
        round,
        messages,
        reason: completeAfterToolCalls && !replyBudgetRenewed ? "completed" : reachedToolCallLimit || replyRound + 1 >= limits.maxRounds ? "limit" : "tools"
      });

      if (completeAfterToolCalls && !replyBudgetRenewed && !reachedToolCallLimit && !invalidateSession) {
        return {
          messages,
          rounds: round + 1,
          finalResult: result,
          finalMessage: result.message,
          stopReason: "completed",
          invalidateSession,
          toolCallCount: totalToolCallCount
        };
      }
    }

    if (resetSession) {
      if (continueAfterReset && !reachedToolCallLimit && replyRound + 1 < limits.maxRounds) continue;
      return {
        messages,
        rounds: round + 1,
        finalResult: result,
        finalMessage: result.message,
        stopReason: "reset",
        invalidateSession,
        toolCallCount: totalToolCallCount
      };
    }
    if (yieldReturn) {
      const resumeMessages = input.runtimeInterrupts?.hasPendingUserMessage() === true
        ? await Promise.resolve(input.buildYieldResumeMessages?.({ round, messages, result }) ?? [])
        : [];
      if (resumeMessages.length > 0 && input.runtimeInterrupts?.consumePendingUserMessage() === true) {
        replyRound = -1;
        replyToolCallCount = 0;
        reachedToolCallLimit = false;
        previousAssistantMessageSignature = undefined;
        messages = [
          ...messages,
          ...cloneLLMMessages(resumeMessages)
        ];
        await input.onMessagesChanged?.({
          round,
          messages,
          reason: "tools"
        });
        if (!invalidateSession) continue;
        return {
          messages,
          rounds: round + 1,
          finalResult: result,
          finalMessage: result.message,
          stopReason: invalidateSession ? "invalidated" : "tool_limit",
          invalidateSession,
          toolCallCount: totalToolCallCount
        };
      }
      return {
        messages,
        rounds: round + 1,
        finalResult: result,
        finalMessage: result.message,
        stopReason: "yield_return",
        invalidateSession,
        toolCallCount: totalToolCallCount
      };
    }
    if (reachedToolCallLimit || replyRound + 1 >= limits.maxRounds) {
      return {
        messages,
        rounds: round + 1,
        finalResult: result,
        finalMessage: result.message,
        stopReason: "tool_limit",
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
        invalidateSession,
        toolCallCount: totalToolCallCount
      };
    }
  }

  return {
    messages,
    rounds: round,
    finalMessage: messages.at(-1) ?? { role: "assistant", content: "" },
    stopReason: "tool_limit",
    invalidateSession,
    toolCallCount: totalToolCallCount
  };
}

function consumePendingUserMessageInterruptMessages(input: LLMToolLoopInput, request: LLMToolLoopRoundRequest): LLMMessage[] {
  if (!input.promptProfile) return [];
  const layer = normalizePromptProfile(input.promptProfile).interruptLayer;
  if (!layer?.enabled) return [];
  if (!request.toolVariables) throw new Error("prompt_context_runtime_required");
  if (input.runtimeInterrupts?.hasPendingUserMessage() !== true) return [];
  if (input.runtimeInterrupts.consumePendingUserMessage() !== true) return [];
  return [promptLayerToMessage(layer, request.toolVariables)];
}

function isAssistantMessageTransformResult(value: LLMToolLoopAssistantMessageTransform | undefined): value is Extract<LLMToolLoopAssistantMessageTransform, { message: LLMMessage }> {
  return Boolean(value && typeof value === "object" && "message" in value);
}

async function executeTool(
  input: LLMToolLoopInput,
  call: LLMToolCall,
  request: LLMToolLoopRoundRequest,
  context: {
    round: number;
    result: LLMChatResult;
    callIndex: number;
    reachedToolCallLimit: boolean;
  }
): Promise<LLMToolLoopExecution> {
  const plugin = toolPluginForCall(input.toolRegistryName ?? defaultToolRegistryName, call.function.name);
  const parsedInput = parseToolInput(call.function.arguments);
  const toolInput = input.transformToolInput?.(call.function.name, parsedInput) ?? parsedInput;
  const toolResult = await plugin.execute({
    id: call.id,
    toolName: call.function.name,
    input: toolInput,
    requester: input.toolCallSource?.requester,
    externalSession: input.toolCallSource?.externalSession
  }, input.buildToolExecutionContext?.({
    round: context.round,
    call,
    callIndex: context.callIndex
  }));
  const toolMessage = {
    role: "tool" as const,
    toolCallId: call.id,
    name: call.function.name,
    content: formatToolMessageContent(toolResult, request.toolVariables)
  };
  return await input.afterToolResult?.({
    ...context,
    call,
    toolInput,
    toolResult,
    toolMessage
  }) ?? {
    message: toolMessage,
    control: toolControlFromResult(toolResult)
  };
}

function formatToolMessageContent(result: ToolResult, runtime: PromptContextRuntime | undefined): string {
  if (!runtime) throw new Error("prompt_context_runtime_required");
  if (!result.ok && typeof result.output === "string") return runtime.renderText(result.output);
  if (!result.ok) return result.error ? `error: ${runtime.renderText(result.error)}` : "error";
  if (typeof result.output === "string") return runtime.renderText(result.output);
  if (result.output === undefined || result.output === null) return "ok";
  if (typeof result.output === "number" || typeof result.output === "boolean") return String(result.output);
  return JSON.stringify(result.output);
}

function toolPluginForCall(registryName: string, toolName: string): ToolPlugin {
  const plugin = toolRegistries.get(registryName)?.get(toolName);
  if (!plugin) throw new Error(`llm_tool_unavailable:${toolName}`);
  return plugin;
}

function buildToolPluginMap(plugins: readonly ToolPlugin[]): Map<string, ToolPlugin> {
  const map = new Map<string, ToolPlugin>();
  for (const plugin of plugins) {
    for (const tool of plugin.listTools()) map.set(tool.name, plugin);
  }
  return map;
}

export function cloneLLMMessages(messages: LLMMessage[]): LLMMessage[] {
  return messages.map((message) => ({
    ...message,
    toolCalls: message.toolCalls?.map((call) => ({ ...call, function: { ...call.function } }))
  }));
}

function assistantLoopMessageSignature(message: LLMMessage): string {
  return stableJson({
    role: message.role,
    content: message.content,
    reasoningContent: message.reasoningContent ?? "",
    toolCalls: message.toolCalls?.map((call) => ({
      name: call.function.name,
      arguments: parseToolArguments(call.function.arguments)
    })) ?? []
  });
}

function parseToolArguments(raw: string): unknown {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : raw;
  } catch {
    return raw;
  }
}

function parseToolInput(raw: string): Record<string, unknown> {
  const parsed = parseToolArguments(raw || "{}");
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function toolControlFromResult(result: ToolResult): LLMToolLoopControl {
  return {
    invalidateSession: result.invalidateLLMSession === true,
    resetSession: result.resetLLMSession === true,
    yieldReturn: result.meta?.yieldReturn === true
  };
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
