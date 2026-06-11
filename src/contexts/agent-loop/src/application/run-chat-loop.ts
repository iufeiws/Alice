import type { AgentEvent, ToolPlugin, ToolResult } from "../contracts/agent-contracts.js";
import type { LLMChatInput, LLMChatResult, LLMClient, LLMToolCall, LLMToolCallDelta } from "../../../llm-gateway/src/index.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import { formatToolResultForLLM as renderToolResultForLLM, renderLLMValue, type LLMTextVariables } from "../../../../contexts/agent-profile/src/application/llm-text-renderer.js";
import { type LLMRequestSender } from "../../../llm-gateway/src/llm-tool-loop.js";
import type { PromptLayer } from "./prompts.js";
import { runAgentLoopExecutionSpec, type AgentLoopExecutionSpec, type AgentLoopToolExecution } from "./agent-loop-executor.js";

const sendChatToolName = "send_chat";
const maxLLMRequestsPerMinute = 10;
const maxLLMRetryAttempts = 3;
const fixedPrefixDefaultTtlMs = 2 * 60 * 60 * 1000;

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
  fixedPrefixCursorMessageId?: number;
};

export type ChatAgentLoopSession = {
  messages: LLMChatInput["messages"];
  requestTimestamps: number[];
  mode: string;
  fixedPrefixCursorMessageId?: number;
  waitChatStartedAt?: number;
  lastCheckChatCursorMessageId?: number;
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
    stream?: boolean;
    toolNames: string[];
  };
  event: AgentEvent;
  toolPlugins: ToolPlugin[];
  session: ChatAgentLoopSession;
  ensureSession(): Promise<ChatAgentLoopSession>;
  appendSessionContext(session: ChatAgentLoopSession): Promise<void>;
  llm: LLMClient;
  llmRequestSender?: LLMRequestSender;
  time: CurrentTimeProvider;
  buildTextVariables(event: AgentEvent): LLMTextVariables;
  noteSessionUpdated(): void;
  getLastCompletedToolName(): string | undefined;
  setLastCompletedToolName(name: string): void;
  applyModeStateToNewSession(mode: ChatAgentModeState): void;
  onSessionRebuilt?(): void;
  isLLMRunCancelled?(): boolean;
  onLLMRequestPrepared?(input: LLMChatInput): void;
  onLLMResponseReceived?(result: LLMChatResult): void;
  onLLMLog?(event: {
    kind: "call_start" | "stream_start" | "stream_end" | "response_received" | "rate_limited" | "retry" | "wait_chat_resume_error";
    round: number;
    stream: boolean;
    model?: string;
    attempt?: number;
    error?: string;
    delayMs?: number;
  }): void;
};

export type ChatAgentLoopResult = {
  message: LLMChatInput["messages"][number];
  sentMessage: boolean;
  invalidateSession?: boolean;
  cancelled?: boolean;
  finalResult?: LLMChatResult;
};

export async function runChatAgentLoop(input: ChatAgentLoopInput): Promise<ChatAgentLoopResult> {
  let session = input.session;
  const toolMap = buildToolMap(input.toolPlugins);
  const visibleToolNames = input.llmInput.toolNames;
  let sendChatCallCount = 0;
  let streamingToolSender: ReturnType<typeof createStreamingSendMessageHandler> | undefined;
  const spec: AgentLoopExecutionSpec = {
    initialMessages: session.messages,
    limits: { maxRounds: 20, maxTotalToolCalls: 20, maxRepeatedToolCalls: 3 },
    async beforeRound({ round }) {
      if (input.isLLMRunCancelled?.()) return { stop: true, messages: session.messages };
      const ensuredSession = await input.ensureSession();
      if (ensuredSession !== session) {
        session = ensuredSession;
        await input.appendSessionContext(session);
      }
      if (session.messages.length === 0) return { stop: true, messages: session.messages };
      const requestTime = input.time.now().epochMs;
      session.requestTimestamps = session.requestTimestamps.filter((timestamp) => requestTime - timestamp < 60_000);
      if (session.requestTimestamps.length >= maxLLMRequestsPerMinute) {
        input.onLLMLog?.({ kind: "rate_limited", round, stream: false, model: input.llmInput.model });
        input.noteSessionUpdated();
        return { stop: true, messages: session.messages };
      }
      session.requestTimestamps.push(requestTime);
      input.noteSessionUpdated();
      return { messages: session.messages };
    },
    buildRequest({ round, messages }) {
      streamingToolSender = createStreamingSendMessageHandler(input.event, toolMap);
      return {
        agentId: input.llmInput.agentId ?? "chat",
        client: input.llmInput.client ?? input.llm,
        messages,
        model: input.llmInput.model,
        temperature: input.llmInput.temperature,
        maxTokens: input.llmInput.maxTokens,
        extraParams: round === 0 ? input.llmInput.extraParams : input.llmInput.followupExtraParams,
        toolNames: visibleToolNames,
        toolVariables: input.buildTextVariables(input.event),
        stream: input.llmInput.stream !== false && Boolean((input.llmInput.client ?? input.llm).chatStream),
        streamHandlers: {
          onToolCallDelta(delta) {
            return streamingToolSender?.onToolCallDelta(delta);
          }
        }
      };
    },
    sendRequest: input.llmRequestSender ?? createLocalLLMRequestSender(input),
    async afterRequest() {
      await streamingToolSender?.finish();
    },
    shouldCancel() {
      return input.isLLMRunCancelled?.() === true;
    },
    selectToolCalls(calls) {
      if (calls.some((call) => isWaitChatToolName(call.function.name))) return calls;
      return calls.some((call) => isSendChatToolName(call.function.name))
        ? calls.filter((call) => isSendChatToolName(call.function.name))
        : calls;
    },
    shouldYieldReturn(calls) {
      return calls.some((call) => isWaitChatToolName(call.function.name));
    },
    shouldDeferToolResult(call, calls) {
      return calls.some((entry) => isWaitChatToolName(entry.function.name))
        && isInboundToolName(call.function.name);
    },
    async executeTool(call, { result }): Promise<AgentLoopToolExecution> {
      const textVariables = input.buildTextVariables(input.event);
      const isConsecutiveSelfie = call.function.name === "selfie" && input.getLastCompletedToolName() === "selfie";
      let reachedToolCallLimit = false;
      if (isSendChatToolName(call.function.name)) {
        sendChatCallCount += 1;
        if (sendChatCallCount >= 5) reachedToolCallLimit = true;
      }
      const streamedResult = streamingToolSender?.resultFor(call.id);
      if (streamedResult) {
        session.lastCheckChatCursorMessageId = checkChatCursorFromResult(call.function.name, streamedResult) ?? session.lastCheckChatCursorMessageId;
        input.setLastCompletedToolName(call.function.name);
        return {
          message: {
            role: "tool" as const,
            toolCallId: call.id,
            name: call.function.name,
            content: formatToolResultForLLM(streamedResult, textVariables)
          },
          control: {
            sentMessage: isSendChatToolName(call.function.name) && streamedResult.ok,
            invalidateSession: streamedResult.invalidateLLMSession === true,
            yieldReturn: streamedResult.meta?.yieldReturn === true,
            reachedToolCallLimit
          }
        };
      }
      const plugin = toolMap.get(call.function.name);
      let toolResult: ToolResult;
      if (isConsecutiveSelfie) {
        toolResult = {
          callId: call.id,
          ok: false,
          error: "selfie cannot be called twice in a row"
        };
      } else if (!plugin) {
        toolResult = {
          callId: call.id,
          ok: false,
          error: `Unknown tool: ${call.function.name}`
        };
      } else {
        try {
          if (isSendChatToolName(call.function.name) && hasUnsafeSendChatArguments(call.function.arguments)) {
            toolResult = {
              callId: call.id,
              ok: false,
              error: "unsafe send_chat arguments"
            };
          } else {
            const toolInput = fixedPrefixToolInput(call.function.name, parseToolArguments(call.function.arguments), session);
            toolResult = await plugin.execute({
              id: call.id,
              toolName: call.function.name,
              input: toolInput,
              requester: input.event.source,
              session: input.event.session
            });
          }
        } catch (error) {
          toolResult = {
            callId: call.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          };
        }
      }

      session.lastCheckChatCursorMessageId = checkChatCursorFromResult(call.function.name, toolResult) ?? session.lastCheckChatCursorMessageId;
      if (isWaitChatToolName(call.function.name) && toolResult.meta?.yieldReturn === true) {
        session.waitChatStartedAt = input.time.now().epochMs;
      }
      input.setLastCompletedToolName(call.function.name);
      const toolMessage = {
        role: "tool" as const,
        toolCallId: call.id,
        name: call.function.name,
        content: formatToolResultForLLM(toolResult, textVariables)
      };
      const control = {
        sentMessage: isSendChatToolName(call.function.name) && toolResult.ok,
        invalidateSession: toolResult.invalidateLLMSession === true,
        yieldReturn: toolResult.meta?.yieldReturn === true,
        reachedToolCallLimit,
        resetSession: false,
        continueAfterReset: false
      };
      if (toolResult.resetLLMSession) {
        if (toolResult.clearFixedPrefix) {
          input.applyModeStateToNewSession(defaultChatAgentModeState());
          return { message: toolMessage, control: { ...control, resetSession: true, continueAfterReset: false, invalidateSession: true } };
        }
        const fixedPrefixKind = typeof toolResult.fixedPrefixKind === "string" && toolResult.fixedPrefixKind
          ? toolResult.fixedPrefixKind
          : undefined;
        const mode = fixedPrefixKind ? "fixed_prefix" : toolResult.llmSessionMode || "normal";
        const modeStaticMessages = mode === "fixed_prefix"
          ? [
            ...cloneLLMMessages(session.messages),
            {
              role: "assistant" as const,
              content: result.message.content,
              reasoningContent: reasoningContentForToolRequest(result.message.reasoningContent, 1),
              toolCalls: [call]
            },
            toolMessage
          ]
          : mode === "normal"
            ? []
            : cloneLLMMessages((toolResult.llmSessionStaticMessages as LLMChatInput["messages"] | undefined) ?? [
              {
                role: "assistant" as const,
                content: result.message.content,
                reasoningContent: reasoningContentForToolRequest(result.message.reasoningContent, 1),
                toolCalls: [call]
              },
              toolMessage
            ]);
        const modeStartedAt = mode === "normal" ? undefined : input.time.now().epochMs;
        const ttlMs = Number.isFinite(toolResult.fixedPrefixTtlMs) ? Number(toolResult.fixedPrefixTtlMs) : fixedPrefixDefaultTtlMs;
        input.applyModeStateToNewSession({
          mode,
          modeStaticMessages,
          modeStaticTokenEstimate: estimateMessagesTokens(modeStaticMessages),
          tokenPressurePreviewBaselines: {},
          modeStartedAt,
          modeExpiresAt: mode === "fixed_prefix" && typeof modeStartedAt === "number" ? modeStartedAt + ttlMs : undefined,
          fixedPrefixKind,
          fixedPrefixCursorMessageId: mode === "fixed_prefix" ? session.lastCheckChatCursorMessageId : undefined
        });
        const shouldContinueAfterReset = mode === "fixed_prefix" || mode !== "normal";
        if (shouldContinueAfterReset) input.onSessionRebuilt?.();
        return {
          message: toolMessage,
          control: {
            ...control,
            resetSession: true,
            continueAfterReset: shouldContinueAfterReset,
            invalidateSession: control.invalidateSession || mode === "normal"
          }
        };
      }
      return { message: toolMessage, control };
    },
    async onMessagesChanged({ messages }) {
      session.messages = messages;
      input.noteSessionUpdated();
    }
  };
  const loopResult = await runAgentLoopExecutionSpec(spec);
  if (loopResult.stopReason === "reset") {
    input.noteSessionUpdated();
  }
  return {
    message: loopResult.finalMessage,
    sentMessage: loopResult.sentMessage,
    invalidateSession: loopResult.invalidateSession,
    cancelled: loopResult.stopReason === "cancelled",
    finalResult: loopResult.finalResult
  };
}

export async function runPromptToolRequest(
  layer: PromptLayer,
  call: {
    id: string;
    toolName: string;
    input: Record<string, unknown>;
    requester?: AgentEvent["source"];
    session?: AgentEvent["session"];
  },
  toolPlugins: ToolPlugin[]
): Promise<ToolResult> {
  if (isSendChatToolName(call.toolName)) {
    return {
      callId: call.id,
      ok: false,
      error: "send_chat cannot run from prompt prebuild"
    };
  }
  const plugin = findToolPlugin(toolPlugins, call.toolName);
  if (!plugin) {
    return {
      callId: call.id,
      ok: false,
      error: `Unknown prompt tool: ${call.toolName}`
    };
  }
  try {
    return await plugin.execute(call);
  } catch (error) {
    return {
      callId: call.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function buildFixedPrefixAppendMessages(input: {
  mode: Pick<ChatAgentModeState, "fixedPrefixCursorMessageId">;
  event: AgentEvent;
  toolPlugins: ToolPlugin[];
  nextToolCallId(): string;
  buildTextVariables(event: AgentEvent): LLMTextVariables;
}): Promise<LLMChatInput["messages"]> {
  const messages: LLMChatInput["messages"] = [];
  const plugin = findToolPlugin(input.toolPlugins, "check_chat");
  if (!plugin) return messages;
  const callId = input.nextToolCallId();
  const publicArguments = {};
  const result = await runPromptToolRequest(
    { id: "fixed_prefix_check_chat", title: "Fixed prefix check", role: "tool_request", enabled: true, content: "", toolName: "check_chat", toolArguments: JSON.stringify(publicArguments), order: 0 },
    {
      id: callId,
      toolName: "check_chat",
      input: { scope: "from_prefix", __fromPrefixAfterMessageId: input.mode.fixedPrefixCursorMessageId ?? 0 },
      requester: input.event.source,
      session: input.event.session
    },
    input.toolPlugins
  );
  messages.push({
    role: "assistant",
    content: "",
    reasoningContent: "Check messages after the fixed prefix cursor.",
    toolCalls: [{
      id: callId,
      type: "function",
      function: {
        name: "check_chat",
        arguments: JSON.stringify(publicArguments)
      }
    }]
  });
  messages.push({
    role: "tool",
    toolCallId: callId,
    name: "check_chat",
    content: formatToolResultForLLM(result, input.buildTextVariables(input.event))
  });
  return messages;
}

export async function buildWaitChatResumeMessages(input: {
  session: ChatAgentLoopSession;
  event: AgentEvent;
  toolPlugins: ToolPlugin[];
  time: CurrentTimeProvider;
  buildTextVariables(event: AgentEvent): LLMTextVariables;
  onLLMLog?: ChatAgentLoopInput["onLLMLog"];
}): Promise<LLMChatInput["messages"]> {
  const pending = pendingWaitChatToolCalls(input.session.messages);
  if (!pending) return [];
  const messages: LLMChatInput["messages"] = [];
  const textVariables = input.buildTextVariables(input.event);
  let waitChatCheckResult: ToolResult | undefined;
  for (const call of pending.calls) {
    let result: ToolResult;
    if (isWaitChatToolName(call.function.name)) {
      waitChatCheckResult ??= await runWaitChatResumeCheck(call.id, input.session, input.event, input.toolPlugins);
      result = {
        ...waitChatCheckResult,
        callId: call.id,
        output: formatWaitChatResumeOutput(waitChatCheckResult, input.session.waitChatStartedAt, input.time, input.onLLMLog)
      };
    } else {
      const toolInput = fixedPrefixToolInput(call.function.name, parseToolArguments(call.function.arguments), input.session);
      result = await runPromptToolRequest(
        { id: `wait_chat_resume_${call.id}`, title: "wait_chat resume", role: "tool_request", enabled: true, content: "", toolName: call.function.name, toolArguments: call.function.arguments, order: 0 },
        {
          id: call.id,
          toolName: call.function.name,
          input: toolInput,
          requester: input.event.source,
          session: input.event.session
        },
        input.toolPlugins
      );
      input.session.lastCheckChatCursorMessageId = checkChatCursorFromResult(call.function.name, result) ?? input.session.lastCheckChatCursorMessageId;
      if (isCheckChatToolName(call.function.name)) waitChatCheckResult ??= result;
    }
    messages.push({
      role: "tool",
      toolCallId: call.id,
      name: call.function.name,
      content: formatToolResultForLLM(result, textVariables)
    });
  }
  return messages;
}

export function findToolPlugin(tools: ToolPlugin[], toolName: string): ToolPlugin | undefined {
  return tools.find((plugin) => plugin.listTools().some((tool) => tool.name === toolName));
}

export function checkChatCursorFromResult(toolName: string, result: ToolResult): number | undefined {
  if (!isCheckChatToolName(toolName)) return undefined;
  return typeof result.messageCursorId === "number" && Number.isFinite(result.messageCursorId) ? result.messageCursorId : undefined;
}

export function defaultChatAgentModeState(): ChatAgentModeState {
  return { mode: "normal", modeStaticMessages: [], modeStaticTokenEstimate: 0, tokenPressurePreviewBaselines: {} };
}

export function cloneLLMMessages(messages: LLMChatInput["messages"]): LLMChatInput["messages"] {
  return messages.map((message) => ({
    ...message,
    toolCalls: message.toolCalls?.map((call) => ({ ...call, function: { ...call.function } }))
  }));
}

export function estimateTextTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    tokens += /[\u4e00-\u9fff]/.test(char) ? 0.6 : 0.3;
  }
  return Math.round(tokens);
}

export function estimateMessagesTokens(messages: LLMChatInput["messages"]): number {
  return estimateTextTokens(messages.map((message) => [
    message.role,
    message.content,
    message.reasoningContent ?? "",
    message.name ?? "",
    message.toolCallId ?? "",
    JSON.stringify(message.toolCalls ?? [])
  ].join("\n")).join("\n"));
}

export function toolResultText(result: ToolResult): string {
  if (typeof result.output === "string") return result.output;
  if (result.output === undefined || result.output === null) return result.error ?? "";
  try {
    return JSON.stringify(result.output);
  } catch {
    return String(result.output);
  }
}

function buildToolMap(toolPlugins: ToolPlugin[]): Map<string, ToolPlugin> {
  const toolMap = new Map<string, ToolPlugin>();
  for (const plugin of toolPlugins) {
    for (const tool of plugin.listTools()) {
      toolMap.set(tool.name, plugin);
    }
    if (plugin.id === "messaging" && toolMap.has(sendChatToolName)) {
      toolMap.set("check_feishu", plugin);
      toolMap.set("check_wechat", plugin);
      toolMap.set("view_messages", plugin);
      toolMap.set("send_feishu", plugin);
      toolMap.set("send_wechat", plugin);
      toolMap.set("send_message", plugin);
    }
  }
  return toolMap;
}

function createLocalLLMRequestSender(input: ChatAgentLoopInput): LLMRequestSender {
  return async (request) => {
    const client = request.client ?? input.llm;
    const requestInput: LLMChatInput = {
      messages: request.messages,
      model: request.model,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      extraParams: request.extraParams,
      tools: buildLocalToolSpecs(input.toolPlugins, request.toolNames, request.toolVariables as LLMTextVariables | undefined)
    };
    input.onLLMRequestPrepared?.(requestInput);
    const useStream = request.stream === true && Boolean(client.chatStream);
    let lastError: unknown;
    let result: LLMChatResult | undefined;
    for (let attempt = 1; attempt <= maxLLMRetryAttempts; attempt += 1) {
      input.onLLMLog?.({ kind: "call_start", round: request.round, stream: useStream, model: requestInput.model, attempt });
      try {
        if (useStream && client.chatStream) {
          input.onLLMLog?.({ kind: "stream_start", round: request.round, stream: true, model: requestInput.model, attempt });
          try {
            result = await client.chatStream(requestInput, request.streamHandlers);
          } finally {
            input.onLLMLog?.({ kind: "stream_end", round: request.round, stream: true, model: requestInput.model, attempt });
          }
        } else {
          result = await client.chat(requestInput);
          input.onLLMLog?.({ kind: "response_received", round: request.round, stream: false, model: requestInput.model, attempt });
        }
        break;
      } catch (error) {
        lastError = error;
        if (attempt >= maxLLMRetryAttempts || !isRetryableLLMError(error)) throw error;
        const delayMs = llmRetryDelayMs(attempt);
        input.onLLMLog?.({
          kind: "retry",
          round: request.round,
          stream: useStream,
          model: requestInput.model,
          attempt,
          error: error instanceof Error ? error.message : String(error),
          delayMs
        });
        await sleep(delayMs);
      }
    }
    if (!result) throw lastError;
    input.onLLMResponseReceived?.(result);
    return result;
  };
}

function buildLocalToolSpecs(toolPlugins: ToolPlugin[], toolNames: string[], variables?: LLMTextVariables): LLMChatInput["tools"] {
  const seen = new Set<string>();
  const specs: LLMChatInput["tools"] = [];
  for (const name of toolNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    const plugin = findToolPlugin(toolPlugins, name);
    const tool = plugin?.listTools().find((entry) => entry.name === name);
    if (!tool) throw new Error(`unknown LLM tool: ${name}`);
    specs.push({
      type: "function",
      function: {
        name: tool.name,
        description: renderLLMTextValue(tool.description, variables ?? {}),
        parameters: renderLLMValue(tool.inputSchema, variables ?? {}) as Record<string, unknown>
      }
    });
  }
  return specs;
}

function createStreamingSendMessageHandler(event: AgentEvent, toolMap: Map<string, ToolPlugin>) {
  const states = new Map<number, StreamingSendMessageState>();
  const resultsByCallId = new Map<string, ToolResult>();
  const sentCounts = new Map<string, number>();
  let sendChain = Promise.resolve();

  return {
    onToolCallDelta(delta: LLMToolCallDelta) {
      const state = states.get(delta.index) ?? new StreamingSendMessageState();
      states.set(delta.index, state);
      const { readyLines } = state.accept(delta);
      const callId = state.callId;
      const plugin = toolMap.get(sendChatToolName);
      if (!callId || !plugin || !isSendChatToolName(state.toolName)) {
        state.restoreReadyLines(readyLines);
        return;
      }
      const lines = state.canStreamNow() && !state.hasUnsafeArguments() ? state.stageStreamingLines(readyLines) : [];
      if (lines.length === 0) return;
      state.dropPendingLines();
      sendChain = sendChain.then(async () => {
        const sendType = state.sendType();
        for (const line of lines) {
          const sentCount = sentCounts.get(callId) ?? 0;
          await sendStreamingLine(plugin, event, callId, sendType, line, resultsByCallId);
          sentCounts.set(callId, sentCount + 1);
        }
      });
    },
    async finish() {
      for (const state of states.values()) {
        if (state.hasUnsafeArguments()) continue;
        const lines = state.finish();
        const callId = state.callId;
        const plugin = toolMap.get(sendChatToolName);
        if (!callId || !plugin || !isSendChatToolName(state.toolName) || !state.shouldSendAsStreamingType()) continue;
        sendChain = sendChain.then(async () => {
          const sendType = state.sendType();
          for (const line of lines) {
            const sentCount = sentCounts.get(callId) ?? 0;
            await sendStreamingLine(plugin, event, callId, sendType, line, resultsByCallId);
            sentCounts.set(callId, sentCount + 1);
          }
        });
      }
      await sendChain;
    },
    resultFor(callId: string) {
      return resultsByCallId.get(callId);
    }
  };
}

async function runWaitChatResumeCheck(
  callId: string,
  session: ChatAgentLoopSession,
  event: AgentEvent,
  toolPlugins: ToolPlugin[]
): Promise<ToolResult> {
  const checkInput = session.mode === "fixed_prefix"
    ? { scope: "from_prefix", __fromPrefixAfterMessageId: session.fixedPrefixCursorMessageId ?? 0 }
    : {};
  const result = await runPromptToolRequest(
    { id: "wait_chat_resume_check_chat", title: "wait_chat resume", role: "tool_request", enabled: true, content: "", toolName: "check_chat", toolArguments: "{}", order: 0 },
    {
      id: callId,
      toolName: "check_chat",
      input: checkInput,
      requester: event.source,
      session: event.session
    },
    toolPlugins
  );
  session.lastCheckChatCursorMessageId = checkChatCursorFromResult("check_chat", result) ?? session.lastCheckChatCursorMessageId;
  return result;
}

function pendingWaitChatToolCalls(messages: LLMChatInput["messages"]): { calls: LLMToolCall[] } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant" || !message.toolCalls || message.toolCalls.length === 0) continue;
    const followingToolCallIds = new Set(
      messages
        .slice(index + 1)
        .filter((entry) => entry.role === "tool" && typeof entry.toolCallId === "string")
        .map((entry) => entry.toolCallId as string)
    );
    const missingCalls = message.toolCalls.filter((call) => !followingToolCallIds.has(call.id));
    if (!missingCalls.some((call) => isWaitChatToolName(call.function.name))) return undefined;
    return { calls: missingCalls };
  }
  return undefined;
}

function formatWaitChatResumeOutput(
  result: ToolResult,
  waitChatStartedAt: number | undefined,
  time: CurrentTimeProvider,
  onLLMLog?: ChatAgentLoopInput["onLLMLog"]
): unknown {
  if (typeof result.output !== "string") return result.output;
  if (typeof waitChatStartedAt !== "number" || !Number.isFinite(waitChatStartedAt)) {
    onLLMLog?.({
      kind: "wait_chat_resume_error",
      round: 0,
      stream: false,
      error: "wait_chat resume missing start time"
    });
    return result.output;
  }
  const duration = formatWaitChatDuration(time.now().epochMs - waitChatStartedAt);
  if (!duration) return result.output;
  const timeMarker = "\n<time>";
  const index = result.output.lastIndexOf(timeMarker);
  if (index === -1) return `${result.output}\n<wait-duration>${duration}</wait-duration>`;
  return `${result.output.slice(0, index)}\n<wait-duration>${duration}</wait-duration>${result.output.slice(index)}`;
}

function formatWaitChatDuration(durationMs: number): string | undefined {
  if (!Number.isFinite(durationMs) || durationMs < 0) return undefined;
  const totalMinutes = Math.max(0, Math.round(durationMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

function fixedPrefixToolInput(toolName: string, input: Record<string, unknown>, session: ChatAgentLoopSession): Record<string, unknown> {
  if (
    session.mode !== "fixed_prefix"
    || !isCheckChatToolName(toolName)
    || input.scope !== "from_prefix"
    || typeof input.__fromPrefixAfterMessageId === "number"
  ) {
    return input;
  }
  return {
    ...input,
    __fromPrefixAfterMessageId: session.fixedPrefixCursorMessageId ?? 0
  };
}

function isCheckChatToolName(toolName: string): boolean {
  return toolName === "check_chat" || toolName === "check_feishu" || toolName === "check_wechat" || toolName === "view_messages";
}

function isInboundToolName(toolName: string | undefined): boolean {
  return isCheckChatToolName(toolName ?? "") || toolName === "search_messages";
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function reasoningContentForToolRequest(reasoningContent: string | undefined, toolCallCount: number): string | undefined {
  if (reasoningContent) return reasoningContent;
  return toolCallCount > 0 ? "Need to call the requested tool." : undefined;
}

function formatToolResultForLLM(result: ToolResult, variables: LLMTextVariables = {}): string {
  return renderToolResultForLLM(result, variables);
}

function renderLLMTextValue(value: string, variables: LLMTextVariables): string {
  return String(renderLLMValue(value, variables));
}

function isRetryableLLMError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(429|500|502|503|504)\b/.test(message)
    || /service[_ ]unavailable|too busy|temporarily|timeout|timed out|fetch failed|ECONNRESET|ETIMEDOUT/i.test(message);
}

function llmRetryDelayMs(attempt: number): number {
  return 1_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendStreamingLine(
  plugin: ToolPlugin,
  event: AgentEvent,
  callId: string,
  type: "message" | "voice",
  line: string,
  resultsByCallId: Map<string, ToolResult>
): Promise<void> {
  const previous = resultsByCallId.get(callId);
  const previousOutput = typeof previous?.output === "string" ? previous.output : "";
  try {
    const result = await plugin.execute({
      id: `${callId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      toolName: sendChatToolName,
      input: { type, content: line },
      requester: event.source,
      session: event.session
    });
    const output = formatToolResultForLLM(result);
    resultsByCallId.set(callId, {
      callId,
      ok: previous?.ok === false ? false : result.ok,
      output: mergeToolOutputs(previousOutput, output),
      error: previous?.error ?? result.error
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    resultsByCallId.set(callId, {
      callId,
      ok: false,
      output: previousOutput,
      error: previous?.error ?? reason
    });
  }
}

function isSendChatToolName(toolName: string | undefined): boolean {
  return toolName === sendChatToolName || toolName === "send_feishu" || toolName === "send_wechat" || toolName === "send_message";
}

function isWaitChatToolName(toolName: string | undefined): boolean {
  return toolName === "wait_chat";
}

function mergeToolOutputs(previousOutput: string, nextOutput: string): string {
  if (!previousOutput) return nextOutput;
  if (!nextOutput) return previousOutput;
  const previousChat = parseChatToolOutput(previousOutput);
  const nextChat = parseChatToolOutput(nextOutput);
  if (!previousChat || !nextChat) return [previousOutput, nextOutput].filter(Boolean).join("\n");
  return `<chat-log>\n${[previousChat.body, nextChat.body].filter(Boolean).join("\n")}\n</chat-log>\n<time>${nextChat.currentTime}<\\time>`;
}

function parseChatToolOutput(output: string): { body: string; currentTime: string } | undefined {
  const match = /^<chat-log>\n([\s\S]*)\n<\/chat-log>\n<time>([\s\S]*?)<\\time>$/.exec(output.trim());
  if (!match) return undefined;
  return { body: match[1], currentTime: match[2] };
}

class StreamingSendMessageState {
  callId?: string;
  toolName?: string;
  private argumentsText = "";
  private scanIndex = 0;
  private contentStarted = false;
  private contentDone = false;
  private escaped = false;
  private unicodeBuffer = "";
  private pendingLine = "";
  private heldStreamingLine: string | undefined;
  private readyLines: string[] = [];
  private pendingLines: string[] = [];
  private explicitStreamingType: "message" | "voice" | undefined;
  private sawNonStreamingType = false;

  accept(delta: LLMToolCallDelta): { readyLines: string[]; pendingLines: string[] } {
    if (delta.id) this.callId = delta.id;
    if (delta.function?.name) this.toolName = delta.function.name;
    if (delta.function?.arguments) {
      this.argumentsText += delta.function.arguments;
      this.updateTypeState();
      this.scan();
    }
    return {
      readyLines: this.drainReadyLines(),
      pendingLines: [...this.pendingLines]
    };
  }

  finish(): string[] {
    const lines = this.shouldSendAsStreamingType()
      ? [...this.pendingLines, ...this.stageStreamingLines(this.drainReadyLines())]
      : [];
    this.pendingLines = [];
    if (this.heldStreamingLine && this.shouldSendAsStreamingType()) lines.push(this.heldStreamingLine);
    this.heldStreamingLine = undefined;
    const tail = this.pendingLine.trim();
    if (tail && this.shouldSendAsStreamingType()) lines.push(tail);
    this.pendingLine = "";
    return lines;
  }

  canStreamNow(): boolean {
    return Boolean(this.explicitStreamingType) && !this.sawNonStreamingType;
  }

  shouldSendAsStreamingType(): boolean {
    return !this.sawNonStreamingType;
  }

  sendType(): "message" | "voice" {
    return this.explicitStreamingType ?? "message";
  }

  dropPendingLines(): void {
    this.pendingLines = [];
  }

  stageStreamingLines(lines: string[]): string[] {
    const ready: string[] = [];
    for (const line of lines) {
      if (this.heldStreamingLine) ready.push(this.heldStreamingLine);
      this.heldStreamingLine = line;
    }
    return ready;
  }

  hasUnsafeArguments(): boolean {
    return hasUnsafeSendChatArguments(this.argumentsText);
  }

  private updateTypeState(): void {
    const typeMatch = /"type"\s*:\s*"([^"]*)"/.exec(this.argumentsText);
    if (!typeMatch) return;
    this.explicitStreamingType = typeMatch[1] === "message" || typeMatch[1] === "voice" ? typeMatch[1] : undefined;
    this.sawNonStreamingType = !this.explicitStreamingType;
  }

  private scan(): void {
    if (!this.contentStarted) {
      const match = /"content"\s*:\s*"/.exec(this.argumentsText.slice(this.scanIndex));
      if (!match) return;
      this.scanIndex += match.index + match[0].length;
      this.contentStarted = true;
    }

    while (this.scanIndex < this.argumentsText.length && !this.contentDone) {
      const char = this.argumentsText[this.scanIndex];
      this.scanIndex += 1;
      if (this.unicodeBuffer) {
        this.unicodeBuffer += char;
        if (this.unicodeBuffer.length === 4) {
          this.pushDecoded(String.fromCharCode(Number.parseInt(this.unicodeBuffer, 16)));
          this.unicodeBuffer = "";
          this.escaped = false;
        }
        continue;
      }
      if (this.escaped) {
        if (char === "u") {
          this.unicodeBuffer = "";
          continue;
        }
        this.pushDecoded(decodeJsonEscape(char));
        this.escaped = false;
        continue;
      }
      if (char === "\\") {
        this.escaped = true;
        continue;
      }
      if (char === "\"") {
        this.contentDone = true;
        continue;
      }
      this.pushDecoded(char);
    }
  }

  private pushDecoded(char: string): void {
    if ((char === "n" || char === "r") && this.pendingLine.endsWith("\\")) {
      this.pendingLine = this.pendingLine.slice(0, -1);
      if (char === "r") return;
      this.pushDecoded("\n");
      return;
    }
    if (char === "\n") {
      const line = this.pendingLine.trim();
      if (line) {
        if (this.canStreamNow()) {
          this.readyLines.push(line);
        } else {
          this.pendingLines.push(line);
        }
      }
      this.pendingLine = "";
      return;
    }
    if (char !== "\r") this.pendingLine += char;
  }

  private drainReadyLines(): string[] {
    const lines = this.readyLines;
    this.readyLines = [];
    return lines;
  }

  restoreReadyLines(lines: string[]): void {
    this.readyLines = [...lines, ...this.readyLines];
  }
}

function decodeJsonEscape(char: string): string {
  if (char === "n") return "\n";
  if (char === "r") return "\r";
  if (char === "t") return "\t";
  if (char === "b") return "\b";
  if (char === "f") return "\f";
  return char;
}

function hasUnsafeSendChatArguments(rawArguments: string): boolean {
  return containsDsmlMarkup(rawArguments) || countJsonContentKeys(rawArguments) > 1;
}

function containsDsmlMarkup(value: string): boolean {
  return /<\s*[｜|]{2}\s*DSML\s*[｜|]{2}/i.test(value);
}

function countJsonContentKeys(raw: string): number {
  return raw.match(/"content"\s*:/g)?.length ?? 0;
}
