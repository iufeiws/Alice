import type { AgentEvent, ToolResult } from "../contracts/agent-contracts.js";
import type { LLMChatInput, LLMChatResult, LLMClient, LLMStreamHandlers } from "../../../llm-gateway/src/index.js";
import type { LLMRequestLogEntry } from "../../../llm-session/src/index.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { AgentRunIndicator, AgentRunIndicatorBeginInput, AgentRunIndicatorOutput, AgentRunIndicatorSession } from "../../../agent-run-indicator/src/index.js";
import type { PromptContextRuntime } from "../../../prompt-context/src/index.js";
import type { PromptProfile } from "../../../../contexts/agent-profile/src/application/build-system-prompt.js";
import { type LLMRequestSender, type LLMRequestSenderInput, type LLMToolLoopContinuation, type LLMToolLoopRoundRequest } from "../../../llm-gateway/src/llm-tool-loop.js";
import { resolveChatLoopToolControl } from "./chat-loop-tool-control.js";
import { fixedPrefixToolInput } from "./chat-loop-session-context.js";
import { buildToolFollowupLLMMessages, type LLMCapabilityFlags } from "./tool-followup-messages.js";
import {
  type AgentFunctionCallLoopSpec,
  type AgentFunctionCallLoopResult,
  type AgentFunctionCallToolExecution
} from "../runtime/agent-loop-runtime.js";

const chatToolName = "Chat";

export type ChatAgentModeState = {
  mode: string;
  modeStaticMessages: LLMChatInput["messages"];
  modeStaticTokenEstimate: number;
  modeStartedAt?: number;
  modeExpiresAt?: number;
  fixedPrefixKind?: string;
  fixedPrefixStartedAt?: string;
};

export type ChatAgentLoopSession = {
  id?: number;
  messages: LLMChatInput["messages"];
  requestTimestamps: number[];
  agentLoopRunSeq?: number;
  mode: string;
  fixedPrefixStartedAt?: string;
  loopStartedAt?: string;
  waitChatStartedAt?: number;
  waitChatMode?: "schedule" | "await_chat";
  waitChatUntil?: number;
  waitChatTarget?: YieldResumeTarget;
  skipNextAppendLayers?: boolean;
};

export type YieldResumeTarget = {
  source: AgentEvent["source"];
  externalSession: AgentEvent["externalSession"];
};

export type ChatAgentLoopInput = {
  llmInput: {
    agentId?: string;
    messages: LLMChatInput["messages"];
    client?: LLMClient;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    extraParams?: Record<string, unknown>;
    followupExtraParams?: Record<string, unknown>;
    presetName?: string;
    stream?: boolean;
    streamHandlers?: LLMStreamHandlers;
    supportsImage?: boolean;
    supportsAudio?: boolean;
    toolNames: string[];
    assistantContentToolCall: {
      mode: "always" | "when_no_tool_calls" | "never";
      toolName: string;
      input: Record<string, unknown>;
      contentInputKey: string;
    };
  };
  event: AgentEvent;
  session: ChatAgentLoopSession;
  ensureSession(): Promise<ChatAgentLoopSession>;
  appendSessionContext(session: ChatAgentLoopSession): Promise<void>;
  llm: LLMClient;
  llmRequestSender: LLMRequestSender;
  /** response 消息格式化完成后的递交钩子(内部调用 llm-requests 的 flushResponseTranscript)。 */
  flushResponseTranscript?(input: { round: number; result: LLMChatResult; request: LLMToolLoopRoundRequest }): void | Promise<void>;
  time: CurrentTimeProvider;
  buildTextVariables(event: AgentEvent): PromptContextRuntime;
  noteSessionUpdated(): void;
  getLastCompletedToolName(): string | undefined;
  setLastCompletedToolName(name: string): void;
  applyModeStateToNewSession(mode: ChatAgentModeState): void;
  onFixedPrefixCleared?(session: ChatAgentLoopSession): void;
  onSessionRebuilt?(): void | Promise<void>;
  isLLMRunCancelled?(): boolean;
  promptProfile?: PromptProfile;
  buildYieldResumeMessages?(session: ChatAgentLoopSession): Promise<LLMChatInput["messages"]> | LLMChatInput["messages"];
  agentLoopRunSeq?: number;
  processRestartContinuation?: {
    snapshot: LLMToolLoopContinuation;
    interruptedToolResult?: ToolResult;
  };
  onProcessRestartCheckpoint?(continuation: LLMToolLoopContinuation): Promise<void> | void;
  onProcessRestartProgress?(continuation: LLMToolLoopContinuation): Promise<void> | void;
  onProcessRestartCancelled?(): Promise<void> | void;
  processRestartRecoveryActive?: boolean;
  onProcessRestartResponseReceived?(): Promise<void> | void;
  onLLMRequestPrepared?(input: LLMChatInput): LLMRequestLogEntry | undefined | void;
  onLLMResponseReceived?(result: LLMChatResult, request?: LLMRequestLogEntry): void;
  agentRunIndicator?: AgentRunIndicator;
  /** 触发该 run 的消息来源账户（用于按账户路由 agent-run 指示卡）。 */
  runAccountId?: string;
  signal?: AbortSignal;
  onAgentRunIndicatorError?(error: unknown): void;
  onLLMLog?(event: {
    kind: "call_start" | "stream_start" | "stream_end" | "response_received" | "rate_limited" | "finish_and_wait_resume_error";
    round: number;
    stream: boolean;
    model?: string;
    attempt?: number;
    error?: string;
  }): void;
};

export type ChatAgentLoopResult = {
  message: LLMChatInput["messages"][number];
  invalidateSession?: boolean;
  cancelled?: boolean;
  finalResult?: LLMChatResult;
  clearReason?: "yield_end";
};

export type PreparedChatAgentLoop = {
  spec: AgentFunctionCallLoopSpec;
  complete(result: AgentFunctionCallLoopResult): ChatAgentLoopResult;
};

export function buildChatAgentLoop(input: ChatAgentLoopInput): PreparedChatAgentLoop {
  let session = input.session;
  let clearReason: "yield_end" | undefined;
  const llmCapabilities: LLMCapabilityFlags = {
    supportsImage: input.llmInput.supportsImage,
    supportsAudio: input.llmInput.supportsAudio
  };
  const visibleToolNames = input.llmInput.toolNames;
  const baseSendRequest = input.llmRequestSender;
  let processRestartRecoveryPending = input.processRestartRecoveryActive === true;
  const sendRequest = createAgentRunIndicatorRequestSender({
    indicator: input.agentRunIndicator,
    sendRequest: baseSendRequest,
    isCancelled: input.isLLMRunCancelled,
    onError: input.onAgentRunIndicatorError,
    runAccountId: input.runAccountId
  });
  const spec: AgentFunctionCallLoopSpec = {
    initialMessages: session.messages,
    continuation: input.processRestartContinuation,
    onProcessRestartCheckpoint: input.onProcessRestartCheckpoint,
    onProcessRestartProgress: input.onProcessRestartProgress,
    onProcessRestartCancelled: input.onProcessRestartCancelled,
    promptProfile: input.promptProfile,
    async beforeRound({ round }) {
      if (input.isLLMRunCancelled?.()) return { stop: true, messages: session.messages };
      const ensuredSession = await input.ensureSession();
      if (ensuredSession !== session) {
        session = ensuredSession;
        await input.appendSessionContext(session);
      }
      if (session.messages.length === 0) return { stop: true, messages: session.messages };
      input.noteSessionUpdated();
      return { messages: session.messages };
    },
    buildRequest({ round, messages }) {
      return {
        agentId: input.llmInput.agentId ?? "chat",
        client: input.llmInput.client ?? input.llm,
        messages,
        model: input.llmInput.model,
        temperature: input.llmInput.temperature,
        maxTokens: input.llmInput.maxTokens,
        extraParams: round === 0 ? input.llmInput.extraParams : input.llmInput.followupExtraParams,
        presetName: input.llmInput.presetName,
        toolNames: visibleToolNames,
        toolVariables: input.buildTextVariables(input.event),
        stream: input.llmInput.stream !== false && Boolean((input.llmInput.client ?? input.llm).chatStream),
        streamHandlers: input.llmInput.streamHandlers,
        signal: input.signal
      };
    },
    async sendRequest(request) {
      try {
        return await sendRequest(request);
      } catch (error) {
        session.skipNextAppendLayers = true;
        input.noteSessionUpdated();
        throw error;
      }
    },
    flushResponseTranscript: input.flushResponseTranscript,
    async afterRequest() {
      if (session.skipNextAppendLayers) session.skipNextAppendLayers = undefined;
      if (processRestartRecoveryPending) {
        processRestartRecoveryPending = false;
        await input.onProcessRestartResponseReceived?.();
      }
    },
    transformAssistantMessage({ round, message }) {
      return contentToolCallAssistantMessage(round, message, input.llmInput.assistantContentToolCall, visibleToolNames);
    },
    shouldCancel() {
      return input.isLLMRunCancelled?.() === true;
    },
    async buildYieldResumeMessages({ messages }) {
      session.messages = messages;
      return await Promise.resolve(input.buildYieldResumeMessages?.(session) ?? []);
    },
    toolCallSource: {
      requester: input.event.source,
      externalSession: input.event.externalSession
    },
    buildToolExecutionContext() {
      return {
        lastCompletedToolName: input.getLastCompletedToolName(),
        agentLoopRunSeq: input.agentLoopRunSeq,
        llmSessionId: session.id,
        llmCapabilities
      };
    },
    transformToolInput: (toolName, toolInput) => fixedPrefixToolInput(toolName, toolInput, session),
    async afterToolResult({ call, result, toolInput, toolResult, toolMessage }): Promise<AgentFunctionCallToolExecution> {
      const followup = buildToolFollowupLLMMessages(toolResult, llmCapabilities);
      if (followup.toolNotices.length > 0) {
        toolMessage.content = [toolMessage.content, ...followup.toolNotices].filter(Boolean).join("\n");
      }

      if (isWaitChatToolName(call.function.name) && toolResult.meta?.yieldReturn === true) {
        const nowMs = input.time.now().epochMs;
        const yieldSeconds = Number(toolResult.meta.yieldSeconds);
        session.waitChatStartedAt = nowMs;
        session.waitChatMode = toolResult.meta.yieldAction;
        session.waitChatUntil = Number.isFinite(yieldSeconds)
          ? nowMs + yieldSeconds * 1000
          : undefined;
        session.waitChatTarget = {
          source: { ...input.event.source },
          externalSession: { ...input.event.externalSession }
        };
      }
      if (toolResult.llmSessionClearReason === "yield_end") clearReason = "yield_end";
      input.setLastCompletedToolName(call.function.name);
      const execution = resolveChatLoopToolControl({
        call,
        toolInput,
        toolResult,
        toolMessage,
        session,
        llmResult: result,
        nowMs: input.time.now().epochMs
      });
      if (toolResult.clearFixedPrefix) input.onFixedPrefixCleared?.(session);
      if (execution.modeState) input.applyModeStateToNewSession(execution.modeState);
      // §7.1: session rebuild 路径(mode_transition 清除)必须完成后才继续下一轮 loop。
      if (execution.sessionRebuilt) await input.onSessionRebuilt?.();
      return followup.messages.length > 0
        ? { ...execution, messages: followup.messages }
        : execution;
    },
    async onMessagesChanged({ messages }) {
      session.messages = messages;
      input.noteSessionUpdated();
    }
  };
  return {
    spec,
    complete(loopResult) {
      if (loopResult.stopReason === "reset") {
        input.noteSessionUpdated();
      }
      return {
        message: loopResult.finalMessage,
        invalidateSession: loopResult.invalidateSession,
        cancelled: loopResult.stopReason === "cancelled",
        finalResult: loopResult.finalResult,
        clearReason
      };
    }
  };

}

export { runPromptToolRequest } from "./agent-loop-tool-executor.js";
export {
  buildWaitChatResumeMessages,
  cloneLLMMessages,
  defaultChatAgentModeState,
  estimateMessagesTokens,
  estimateTextTokens,
  fixedPrefixToolInput,
  findToolPlugin,
  hasPendingWaitChatToolCall,
  toolResultText
} from "./chat-loop-session-context.js";

function createAgentRunIndicatorRequestSender(input: {
  indicator?: AgentRunIndicator;
  sendRequest: LLMRequestSender;
  isCancelled?(): boolean;
  onError?(error: unknown): void;
  runAccountId?: string;
}): LLMRequestSender {
  if (!input.indicator) return input.sendRequest;
  const indicator = input.indicator;

  return async (request) => {
    let session = await beginIndicator(indicator, {
      agentId: request.agentId,
      round: request.round,
      accountId: input.runAccountId
    }, input.onError);
    const streamHandlers = withAgentRunIndicatorStreamHandlers(request.streamHandlers, {
      getSession: () => session,
      disableSession() {
        session = undefined;
      },
      onError: input.onError
    });

    try {
      const result = await input.sendRequest({
        ...request,
        streamHandlers
      });
      if (input.isCancelled?.()) {
        await failIndicatorSession(session, new Error("llm_run_cancelled"), input.onError);
      } else {
        await finishIndicatorSession(session, outputFromAssistantMessage(result.message), input.onError);
      }
      return result;
    } catch (error) {
      await failIndicatorSession(session, error, input.onError);
      throw error;
    }
  };
}

async function beginIndicator(
  indicator: AgentRunIndicator,
  beginInput: AgentRunIndicatorBeginInput,
  onError: ((error: unknown) => void) | undefined
): Promise<AgentRunIndicatorSession | undefined> {
  try {
    return await indicator.begin(beginInput);
  } catch (error) {
    onError?.(error);
    return undefined;
  }
}

function withAgentRunIndicatorStreamHandlers(
  handlers: LLMStreamHandlers | undefined,
  input: {
    getSession(): AgentRunIndicatorSession | undefined;
    disableSession(): void;
    onError?(error: unknown): void;
  }
): LLMStreamHandlers {
  return {
    ...handlers,
    async onReasoningDelta(delta) {
      await handlers?.onReasoningDelta?.(delta);
      const session = input.getSession();
      if (!session) return;
      try {
        await session.appendReasoningDelta(delta);
      } catch (error) {
        input.onError?.(error);
        input.disableSession();
        await failIndicatorSession(session, error, input.onError);
      }
    },
    async onContentDelta(delta) {
      await handlers?.onContentDelta?.(delta);
      const session = input.getSession();
      if (!session) return;
      try {
        await session.appendContentDelta(delta);
      } catch (error) {
        input.onError?.(error);
        input.disableSession();
        await failIndicatorSession(session, error, input.onError);
      }
    },
    async onToolCallDelta(delta) {
      await handlers?.onToolCallDelta?.(delta);
      const session = input.getSession();
      if (!session) return;
      try {
        await session.appendToolCallDelta({
          index: delta.index,
          id: delta.id,
          name: delta.function?.name,
          arguments: delta.function?.arguments
        });
      } catch (error) {
        input.onError?.(error);
        input.disableSession();
        await failIndicatorSession(session, error, input.onError);
      }
    }
  };
}

async function finishIndicatorSession(
  session: AgentRunIndicatorSession | undefined,
  output: AgentRunIndicatorOutput,
  onError: ((error: unknown) => void) | undefined
): Promise<void> {
  if (!session) return;
  try {
    await session.finish(output);
  } catch (error) {
    onError?.(error);
  }
}

async function failIndicatorSession(
  session: AgentRunIndicatorSession | undefined,
  error: unknown,
  onError: ((error: unknown) => void) | undefined
): Promise<void> {
  if (!session) return;
  try {
    await session.fail(error);
  } catch (failError) {
    onError?.(failError);
  }
}

function isWaitChatToolName(toolName: string | undefined): boolean {
  return toolName === "Yield";
}

function outputFromAssistantMessage(message: LLMChatResult["message"]): AgentRunIndicatorOutput {
  return {
    reasoning: message.reasoningContent ?? "",
    content: messageContentText(message.content),
    toolCalls: (message.toolCalls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments
    }))
  };
}

function messageContentText(content: LLMChatInput["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function contentToolCallAssistantMessage(
  round: number,
  message: LLMChatResult["message"],
  config: ChatAgentLoopInput["llmInput"]["assistantContentToolCall"],
  visibleToolNames: string[]
): LLMChatResult["message"] | { message: LLMChatResult["message"]; completeAfterToolCalls: boolean } {
  if (config.mode === "never") return message;
  if (!visibleToolNames.includes(config.toolName)) return message;
  const hadToolCalls = (message.toolCalls?.length ?? 0) > 0;
  if (config.mode === "when_no_tool_calls" && hadToolCalls) return message;
  const content = messageContentText(message.content).trim();
  if (!content) return message;
  return {
    message: {
      ...message,
      content: "",
      toolCalls: [{
        id: `assistant_content_${round + 1}`,
        type: "function",
        function: {
          name: config.toolName,
          arguments: JSON.stringify({
            ...config.input,
            [config.contentInputKey]: content
          })
        }
      }, ...(message.toolCalls ?? [])]
    },
    completeAfterToolCalls: !hadToolCalls
  };
}
