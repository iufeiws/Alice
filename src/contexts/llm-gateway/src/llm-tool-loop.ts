import type { LLMChatResult, LLMClient, LLMMessage, LLMStreamHandlers, LLMToolCall } from "./index.js";
import type { AgentEvent, ToolCall, ToolDefinition, ToolExecutionContext, ToolExecutionReporter, ToolExecutionReportSession, ToolPlugin, ToolResult } from "../../agent-loop/src/contracts/agent-contracts.js";
import { normalizePromptProfile, type PromptProfile } from "../../agent-profile/src/application/build-system-prompt.js";
import { promptMessageToMessage } from "../../agent-profile/src/domain/prompt-layer.js";
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
  /** 延迟递交 response transcript: 消息在 transform(格式化)完成后由 flushResponseTranscript 递交最终版本。 */
  deferResponseTranscript?: boolean;
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

export type LLMToolLoopContinuation = {
  version: 1;
  messages: LLMMessage[];
  round: number;
  replyRound: number;
  previousAssistantMessageSignature?: string;
  totalToolCallCount: number;
  replyToolCallCount: number;
  invalidateSession: boolean;
  result: LLMChatResult;
  completeAfterToolCalls: boolean;
  interruptedCallIndex: number;
  executedCalls: LLMToolCall[];
  toolMessages: LLMMessage[];
  reachedToolCallLimit: boolean;
  resetSession: boolean;
  continueAfterReset: boolean;
  yieldReturn: boolean;
};

export type LLMToolLoopInput = {
  initialMessages: LLMMessage[];
  continuation?: {
    snapshot: LLMToolLoopContinuation;
    interruptedToolResult?: ToolResult;
  };
  buildRequest(input: { round: number; messages: LLMMessage[] }): Promise<LLMToolLoopRoundRequest> | LLMToolLoopRoundRequest;
  sendRequest: LLMRequestSender;
  /**
   * response 消息最终化(transformAssistantMessage 格式化)后的递交钩子。
   * 存在时 sendRequest 会以 deferResponseTranscript 延迟递交,
   * 由本钩子在格式化完成后递交最终版本, 保证 transcript 与提交版本一致。
   */
  flushResponseTranscript?(input: { round: number; result: LLMChatResult; request: LLMToolLoopRoundRequest }): void | Promise<void>;
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
  onProcessRestartCheckpoint?(continuation: LLMToolLoopContinuation): Promise<void> | void;
  onProcessRestartProgress?(continuation: LLMToolLoopContinuation): Promise<void> | void;
  onProcessRestartCancelled?(): Promise<void> | void;
  limits?: LLMToolLoopLimits;
};

const defaultToolRegistryName = "default";
type RegisteredTool = { plugin: ToolPlugin; definition: ToolDefinition };

const toolRegistries = new Map<string, Map<string, RegisteredTool>>();
let toolExecutionReporter: ToolExecutionReporter | undefined;

export function setLLMToolExecutionReporter(reporter: ToolExecutionReporter | undefined): void {
  toolExecutionReporter = reporter;
}

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
  return executeToolPlugin(toolForCall(registryName, call.toolName), call, context);
}

export const defaultLLMToolLoopLimits: Required<LLMToolLoopLimits> = {
  maxRounds: 100,
  maxTotalToolCalls: 100
};

export async function runLLMToolLoop(input: LLMToolLoopInput): Promise<LLMToolLoopResult> {
  const limits = { ...defaultLLMToolLoopLimits, ...(input.limits ?? {}) };
  let pendingContinuation = input.continuation?.snapshot;
  let messages = cloneLLMMessages(pendingContinuation?.messages ?? input.initialMessages);
  let previousAssistantMessageSignature = pendingContinuation?.previousAssistantMessageSignature;
  let totalToolCallCount = pendingContinuation?.totalToolCallCount ?? 0;
  let replyToolCallCount = pendingContinuation?.replyToolCallCount ?? 0;
  let invalidateSession = pendingContinuation?.invalidateSession ?? false;
  let round = pendingContinuation?.round ?? 0;
  let replyRound = pendingContinuation?.replyRound ?? 0;

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
    const resumedContinuation = pendingContinuation;
    const resumingToolRound = resumedContinuation !== undefined;
    const before = resumingToolRound ? undefined : await input.beforeRound?.({ round, messages });
    if (before?.messages) messages = cloneLLMMessages(before.messages);
    if (before?.stop || (!resumingToolRound && messages.length === 0)) {
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
    let completeAfterToolCalls = false;
    if (resumedContinuation) {
      result = cloneLLMChatResult(resumedContinuation.result);
      completeAfterToolCalls = resumedContinuation.completeAfterToolCalls;
    } else {
      const requestInput = {
        ...request,
        round,
        messages: cloneLLMMessages(request.messages ?? messages),
        // 有 flushResponseTranscript 时延迟递交 response, 由格式化完成后统一递交。
        deferResponseTranscript: input.flushResponseTranscript !== undefined
      };
      try {
        result = await input.sendRequest(requestInput);
      } catch (error) {
        if (input.shouldCancel?.()) return cancelledResult(round + 1);
        throw error;
      }
      const transformed = input.transformAssistantMessage?.({ round, message: result.message });
      const transformedMessage = isAssistantMessageTransformResult(transformed) ? transformed.message : transformed ?? result.message;
      completeAfterToolCalls = isAssistantMessageTransformResult(transformed) && transformed.completeAfterToolCalls === true;
      result = transformedMessage === result.message ? result : { ...result, message: transformedMessage };
      const assistantMessageSignature = assistantLoopMessageSignature(result.message);
      if (assistantMessageSignature === previousAssistantMessageSignature) {
        throw new Error("llm_tool_loop_repeated_assistant_message");
      }
      previousAssistantMessageSignature = assistantMessageSignature;
      await input.afterRequest?.({ round, result, messages });
      // 递交最终(格式化后)的 assistant 消息; 与后续 onMessagesChanged 提交的版本一致。
      await input.flushResponseTranscript?.({ round, result, request: requestInput });
      if (input.shouldCancel?.()) return cancelledResult(round + 1, result);
    }

    const calls = result.message.toolCalls ?? [];
    if (calls.length === 0) {
      // 完整消息追加(与 flushResponseTranscript 递交的最终版本一致), 不再重建简化对象。
      messages = [
        ...messages,
        cloneLLMMessage(result.message)
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

    let reachedToolCallLimit = resumedContinuation?.reachedToolCallLimit ?? false;
    let resetSession = resumedContinuation?.resetSession ?? false;
    let continueAfterReset = resumedContinuation?.continueAfterReset ?? false;
    let yieldReturn = resumedContinuation?.yieldReturn ?? false;
    const executedCalls: LLMToolCall[] = cloneLLMToolCalls(resumedContinuation?.executedCalls ?? []);
    const toolMessages: LLMMessage[] = cloneLLMMessages(resumedContinuation?.toolMessages ?? []);
    const firstCallIndex = resumedContinuation?.interruptedCallIndex ?? 0;
    pendingContinuation = undefined;
    for (let callIndex = firstCallIndex; callIndex < calls.length; callIndex += 1) {
      const call = calls[callIndex];
      const recoveringInterruptedCall = resumedContinuation !== undefined
        && input.continuation?.interruptedToolResult !== undefined
        && callIndex === firstCallIndex;
      if (!recoveringInterruptedCall) {
        totalToolCallCount += 1;
        replyToolCallCount += 1;
      }
      if (replyToolCallCount >= limits.maxTotalToolCalls) reachedToolCallLimit = true;

      if (input.shouldCancel?.()) return cancelledResult(round + 1, result);
      await input.beforeTool?.({ round, call, callIndex });
      if (input.shouldCancel?.()) return cancelledResult(round + 1, result);
      if (!recoveringInterruptedCall) executedCalls.push(call);
      const execution = await executeTool(input, call, request, {
        round,
        result,
        callIndex,
        reachedToolCallLimit,
        continuation: () => ({
          version: 1,
          messages: cloneLLMMessages(messages),
          round,
          replyRound,
          previousAssistantMessageSignature,
          totalToolCallCount,
          replyToolCallCount,
          invalidateSession,
          result: cloneLLMChatResult(result),
          completeAfterToolCalls,
          interruptedCallIndex: callIndex,
          executedCalls: cloneLLMToolCalls(executedCalls),
          toolMessages: cloneLLMMessages(toolMessages),
          reachedToolCallLimit,
          resetSession,
          continueAfterReset,
          yieldReturn
        }),
        recoveredToolResult: recoveringInterruptedCall ? input.continuation?.interruptedToolResult : undefined
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
      if (resumedContinuation) {
        await input.onProcessRestartProgress?.({
          version: 1,
          messages: cloneLLMMessages(messages),
          round,
          replyRound,
          previousAssistantMessageSignature,
          totalToolCallCount,
          replyToolCallCount,
          invalidateSession,
          result: cloneLLMChatResult(result),
          completeAfterToolCalls,
          interruptedCallIndex: callIndex + 1,
          executedCalls: cloneLLMToolCalls(executedCalls),
          toolMessages: cloneLLMMessages(toolMessages),
          reachedToolCallLimit,
          resetSession,
          continueAfterReset,
          yieldReturn
        });
      }
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
        // 完整消息追加(与 flushResponseTranscript 递交的最终版本一致), 不再重建简化对象。
        cloneLLMMessage(result.message),
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
  const layer = normalizePromptProfile(input.promptProfile).interruptLayer!;
  const messages = layer.messages.filter((message) => message.meta.enabled);
  if (messages.length === 0) return [];
  if (!request.toolVariables) throw new Error("prompt_context_runtime_required");
  if (input.runtimeInterrupts?.hasPendingUserMessage() !== true) return [];
  if (input.runtimeInterrupts.consumePendingUserMessage() !== true) return [];
  return messages.map((message) => promptMessageToMessage(message, request.toolVariables!));
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
    continuation(): LLMToolLoopContinuation;
    recoveredToolResult?: ToolResult;
  }
): Promise<LLMToolLoopExecution> {
  const tool = toolForCall(input.toolRegistryName ?? defaultToolRegistryName, call.function.name);
  const parsedInput = parseToolInput(call.function.arguments);
  const toolInput = input.transformToolInput?.(call.function.name, parsedInput) ?? parsedInput;
  let toolResult: ToolResult;
  let processRestartPrepared = false;
  const cancelProcessRestart = async (): Promise<void> => {
    if (!processRestartPrepared) return;
    processRestartPrepared = false;
    await input.onProcessRestartCancelled?.();
  };
  if (context.recoveredToolResult) {
    if (context.recoveredToolResult.callId !== call.id) throw new Error("llm_tool_loop_continuation_call_mismatch");
    toolResult = context.recoveredToolResult;
  } else try {
    const baseExecutionContext = input.buildToolExecutionContext?.({
      round: context.round,
      call,
      callIndex: context.callIndex
    });
    toolResult = await executeToolPlugin(tool, {
      id: call.id,
      toolName: call.function.name,
      input: toolInput,
      requester: input.toolCallSource?.requester,
      externalSession: input.toolCallSource?.externalSession
    }, {
      ...baseExecutionContext,
      signal: baseExecutionContext?.signal ?? request.signal,
      prepareProcessRestart: input.onProcessRestartCheckpoint
        ? async () => {
          await input.onProcessRestartCheckpoint?.(context.continuation());
          processRestartPrepared = true;
        }
        : baseExecutionContext?.prepareProcessRestart,
      cancelProcessRestart: input.onProcessRestartCancelled
        ? cancelProcessRestart
        : baseExecutionContext?.cancelProcessRestart
    });
  } catch (error) {
    toolResult = {
      callId: call.id,
      ok: false,
      output: `<error type="tool crash">${escapeXmlText(error instanceof Error ? error.message : String(error))}</error>`
    };
  }
  await cancelProcessRestart();
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

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function toolForCall(registryName: string, toolName: string): RegisteredTool {
  const tool = toolRegistries.get(registryName)?.get(toolName);
  if (!tool) throw new Error(`llm_tool_unavailable:${toolName}`);
  return tool;
}

function buildToolPluginMap(plugins: readonly ToolPlugin[]): Map<string, RegisteredTool> {
  const map = new Map<string, RegisteredTool>();
  for (const plugin of plugins) {
    for (const definition of plugin.listTools()) map.set(definition.name, { plugin, definition });
  }
  return map;
}

async function executeToolPlugin(tool: RegisteredTool, call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
  // 卡片 reporter 的 begin/finish 涉及飞书网络往返，改为后台执行，避免阻塞 tool 执行
  const reportPromise = tool.definition.suppressExecutionCard
    ? undefined
    : settleExecutionReport(toolExecutionReporter?.begin(call));
  const reportProgress = reportPromise
    ? (content: string) => void reportPromise.then((report) => report?.appendProgress(content)).catch(() => undefined)
    : context?.reportProgress;
  try {
    const result = await tool.plugin.execute(call, {
      ...context,
      reportProgress
    });
    void reportPromise?.then((report) => report?.finish(result)).catch(() => undefined);
    return result;
  } catch (error) {
    void reportPromise?.then((report) => report?.fail(error)).catch(() => undefined);
    throw error;
  }
}

function settleExecutionReport(
  value: ToolExecutionReportSession | Promise<ToolExecutionReportSession | undefined> | undefined
): Promise<ToolExecutionReportSession | undefined> | undefined {
  return value === undefined ? undefined : Promise.resolve(value).catch(() => undefined);
}

export function cloneLLMMessages(messages: LLMMessage[]): LLMMessage[] {
  return messages.map(cloneLLMMessage);
}

export function cloneLLMMessage(message: LLMMessage): LLMMessage {
  return {
    ...message,
    toolCalls: message.toolCalls?.map((call) => ({ ...call, function: { ...call.function } }))
  };
}

function cloneLLMToolCalls(calls: LLMToolCall[]): LLMToolCall[] {
  return calls.map((call) => ({ ...call, function: { ...call.function } }));
}

function cloneLLMChatResult(result: LLMChatResult): LLMChatResult {
  return {
    ...result,
    message: cloneLLMMessages([result.message])[0]
  };
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
    continueAfterReset: result.continueAfterReset === true,
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
