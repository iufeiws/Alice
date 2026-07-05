import type { AgentEvent } from "../contracts/agent-contracts.js";
import type { LLMChatInput, LLMChatResult, LLMClient, LLMStreamHandlers, LLMToolCall } from "../../../llm-gateway/src/index.js";
import type { LLMRequestLogEntry } from "../../../llm-session/src/index.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { AgentRunIndicator, AgentRunIndicatorSession } from "../../../agent-run-indicator/src/index.js";
import type { PromptContextRuntime } from "../../../prompt-context/src/index.js";
import type { PromptProfile } from "../../../../contexts/agent-profile/src/application/build-system-prompt.js";
import { executeRegisteredLLMTool, type LLMRequestSender } from "../../../llm-gateway/src/llm-tool-loop.js";
import { buildAgentFunctionCallLoopSpec } from "./agent-function-call-loop.js";
import { runPromptToolRequest } from "./agent-loop-tool-executor.js";
import { resolveChatLoopToolControl } from "./chat-loop-tool-control.js";
import { fixedPrefixToolInput } from "./chat-loop-session-context.js";
import { buildToolFollowupLLMMessages, type LLMCapabilityFlags } from "./tool-followup-messages.js";
import {
  claimAgentLoopRequestWindow,
  type AgentFunctionCallLoopSpec,
  type AgentFunctionCallLoopResult,
  type AgentFunctionCallToolExecution
} from "../runtime/agent-loop-runtime.js";

const chatToolName = "Chat";
const maxLLMRequestsPerMinute = 10;

type ChatAgentTokenPressurePreviewBaseline = {
  inputTokens: number;
  previewTokens: number;
};

export type ChatAgentModeState = {
  mode: string;
  modeStaticMessages: LLMChatInput["messages"];
  modeStaticTokenEstimate: number;
  tokenPressurePreviewBaselines: Record<string, ChatAgentTokenPressurePreviewBaseline>;
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
  skipNextAppendLayers?: boolean;
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
  };
  event: AgentEvent;
  session: ChatAgentLoopSession;
  ensureSession(): Promise<ChatAgentLoopSession>;
  appendSessionContext(session: ChatAgentLoopSession): Promise<void>;
  llm: LLMClient;
  llmRequestSender: LLMRequestSender;
  time: CurrentTimeProvider;
  buildTextVariables(event: AgentEvent): PromptContextRuntime;
  noteSessionUpdated(): void;
  getLastCompletedToolName(): string | undefined;
  setLastCompletedToolName(name: string): void;
  applyModeStateToNewSession(mode: ChatAgentModeState): void;
  onFixedPrefixCleared?(session: ChatAgentLoopSession): void;
  onSessionRebuilt?(): void;
  isLLMRunCancelled?(): boolean;
  promptProfile?: PromptProfile;
  buildYieldResumeMessages?(session: ChatAgentLoopSession): Promise<LLMChatInput["messages"]> | LLMChatInput["messages"];
  agentLoopRunSeq?: number;
  onLLMRequestPrepared?(input: LLMChatInput): LLMRequestLogEntry | undefined | void;
  onLLMResponseReceived?(result: LLMChatResult, request?: LLMRequestLogEntry): void;
  agentRunIndicator?: AgentRunIndicator;
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
};

export type PreparedChatAgentLoop = {
  spec: AgentFunctionCallLoopSpec;
  complete(result: AgentFunctionCallLoopResult): ChatAgentLoopResult;
};

export function buildChatAgentLoop(input: ChatAgentLoopInput): PreparedChatAgentLoop {
  let session = input.session;
  const llmCapabilities: LLMCapabilityFlags = {
    supportsImage: input.llmInput.supportsImage,
    supportsAudio: input.llmInput.supportsAudio
  };
  const visibleToolNames = input.llmInput.toolNames;
  const baseSendRequest = input.llmRequestSender;
  const sendRequest = createAgentRunIndicatorRequestSender({
    indicator: input.agentRunIndicator,
    sendRequest: baseSendRequest,
    isCancelled: input.isLLMRunCancelled,
    onError: input.onAgentRunIndicatorError
  });
  const spec: AgentFunctionCallLoopSpec = buildAgentFunctionCallLoopSpec({
    initialMessages: session.messages,
    promptProfile: input.promptProfile,
    async beforeRound({ round }) {
      if (input.isLLMRunCancelled?.()) return { stop: true, messages: session.messages };
      const ensuredSession = await input.ensureSession();
      if (ensuredSession !== session) {
        session = ensuredSession;
        await input.appendSessionContext(session);
      }
      if (session.messages.length === 0) return { stop: true, messages: session.messages };
      const requestTime = input.time.now().epochMs;
      const requestWindow = claimAgentLoopRequestWindow({
        session,
        nowMs: requestTime,
        windowMs: 60_000,
        maxRequests: maxLLMRequestsPerMinute
      });
      if (!requestWindow.allowed) {
        input.onLLMLog?.({ kind: "rate_limited", round, stream: false, model: input.llmInput.model });
        input.noteSessionUpdated();
        return { stop: true, messages: session.messages };
      }
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
        streamHandlers: input.llmInput.streamHandlers
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
    async afterRequest({ round, result }) {
      if (session.skipNextAppendLayers) {
        session.skipNextAppendLayers = undefined;
      }
      await sendAssistantContentAsChat(round, result.message.content);
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
    async afterToolResult({ call, round, result, toolInput, toolResult, toolMessage }): Promise<AgentFunctionCallToolExecution> {
      const followup = buildToolFollowupLLMMessages(toolResult, llmCapabilities);
      if (followup.toolNotices.length > 0) {
        toolMessage.content = [toolMessage.content, ...followup.toolNotices].filter(Boolean).join("\n");
      }

      if (isWaitChatToolName(call.function.name) && toolResult.meta?.yieldReturn === true) {
        session.waitChatStartedAt = input.time.now().epochMs;
      }
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
      if (execution.sessionRebuilt) input.onSessionRebuilt?.();
      return followup.messages.length > 0
        ? { ...execution, messages: followup.messages }
        : execution;
    },
    async onMessagesChanged({ messages }) {
      session.messages = messages;
      input.noteSessionUpdated();
    }
  });
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
        finalResult: loopResult.finalResult
      };
    }
  };

  async function sendAssistantContentAsChat(round: number, content: LLMChatInput["messages"][number]["content"]): Promise<boolean> {
    const parts = parseAssistantChatBlocks(messageContentText(content));
    if (parts.length === 0 || !visibleToolNames.includes(chatToolName)) return false;
    let sent = false;
    for (const [index, part] of parts.entries()) {
      const result = await executeRegisteredLLMTool("default", {
        id: `assistant_content_send_${round}_${index + 1}`,
        toolName: chatToolName,
        input: { action: "send", type: part.type, alice: part.alice, content: part.content },
        requester: input.event.source,
        externalSession: input.event.externalSession
      }, {
        lastCompletedToolName: input.getLastCompletedToolName(),
        agentLoopRunSeq: input.agentLoopRunSeq,
        llmSessionId: session.id,
        llmCapabilities
      });
      sent = sent || result.ok;
    }
    return sent;
  }
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
  toolResultText
} from "./chat-loop-session-context.js";

function createAgentRunIndicatorRequestSender(input: {
  indicator?: AgentRunIndicator;
  sendRequest: LLMRequestSender;
  isCancelled?(): boolean;
  onError?(error: unknown): void;
}): LLMRequestSender {
  if (!input.indicator) return input.sendRequest;
  const indicator = input.indicator;

  return async (request) => {
    let session = await beginIndicator(indicator, {
      agentId: request.agentId,
      round: request.round
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
        session = await appendIndicatorToolCalls(session, result.message.toolCalls ?? [], input.onError);
        await finishIndicatorSession(session, input.onError);
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
  beginInput: { agentId?: string; round: number },
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
    }
  };
}

async function appendIndicatorToolCalls(
  session: AgentRunIndicatorSession | undefined,
  calls: LLMToolCall[],
  onError: ((error: unknown) => void) | undefined
): Promise<AgentRunIndicatorSession | undefined> {
  for (const call of calls) {
    if (!session) return undefined;
    try {
      await session.appendToolCall({
        name: call.function.name,
        arguments: call.function.arguments
      });
    } catch (error) {
      onError?.(error);
      await failIndicatorSession(session, error, onError);
      return undefined;
    }
  }
  return session;
}

async function finishIndicatorSession(
  session: AgentRunIndicatorSession | undefined,
  onError: ((error: unknown) => void) | undefined
): Promise<void> {
  if (!session) return;
  try {
    await session.finish();
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

function messageContentText(content: LLMChatInput["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

type AssistantChatBlock = {
  type: "message" | "markdown" | "image" | "voice";
  alice: "core" | "shell";
  content: string;
};

function parseAssistantChatBlocks(text: string): AssistantChatBlock[] {
  const blocks: AssistantChatBlock[] = [];
  const openTag = /<\s*chat\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = openTag.exec(text))) {
    const contentStart = openTag.lastIndex;
    const closeMatch = /<\s*\/\s*chat\b[^>]*>/gi.exec(text.slice(contentStart));
    const contentEnd = closeMatch ? contentStart + closeMatch.index : text.length;
    const content = text.slice(contentStart, contentEnd).trim();
    if (content) {
      blocks.push({
        type: normalizeChatType(readTagAttribute(match[1], "type")),
        alice: normalizeAliceName(readTagAttribute(match[1], "alice")),
        content
      });
    }
    openTag.lastIndex = closeMatch ? contentEnd + closeMatch[0].length : text.length;
  }
  return blocks;
}

function readTagAttribute(raw: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(raw);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function normalizeChatType(value: string | undefined): AssistantChatBlock["type"] {
  return value === "markdown" || value === "image" || value === "voice" ? value : "message";
}

function normalizeAliceName(value: string | undefined): AssistantChatBlock["alice"] {
  return value === "core" ? "core" : "shell";
}
