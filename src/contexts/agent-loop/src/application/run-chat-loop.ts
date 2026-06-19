import type { AgentEvent, ToolPlugin, ToolResult } from "../contracts/agent-contracts.js";
import type { LLMChatInput, LLMChatResult, LLMClient, LLMToolCall, LLMToolCallDelta } from "../../../llm-gateway/src/index.js";
import type { LLMRequestLogEntry } from "../../../llm-session/src/index.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import { type LLMTextVariables } from "../../../../contexts/agent-profile/src/application/llm-text-renderer.js";
import { type LLMRequestSender } from "../../../llm-gateway/src/llm-tool-loop.js";
import { buildAgentFunctionCallLoopSpec } from "./agent-function-call-loop.js";
import { buildAgentLoopToolMap, createAgentLoopToolExecutor, formatAgentLoopToolResultForLLM } from "./agent-loop-tool-executor.js";
import { resolveChatLoopToolControl } from "./chat-loop-tool-control.js";
import { createChatLoopRequestSender } from "./chat-loop-request-sender.js";
import { checkChatCursorFromResult, fixedPrefixToolInput } from "./chat-loop-session-context.js";
import { buildToolFollowupLLMMessages, type LLMCapabilityFlags } from "./tool-followup-messages.js";
import {
  claimAgentLoopRequestWindow,
  type AgentFunctionCallLoopSpec,
  type AgentFunctionCallLoopResult,
  type AgentFunctionCallToolExecution
} from "../runtime/agent-loop-runtime.js";

const sendChatToolName = "send_chat";
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
  fixedPrefixCursorMessageId?: number;
};

export type ChatAgentLoopSession = {
  id?: number;
  messages: LLMChatInput["messages"];
  requestTimestamps: number[];
  agentLoopRunSeq?: number;
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
    presetName?: string;
    stream?: boolean;
    supportsImage?: boolean;
    supportsAudio?: boolean;
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
  agentLoopRunSeq?: number;
  onLLMRequestPrepared?(input: LLMChatInput): LLMRequestLogEntry | undefined | void;
  onLLMResponseReceived?(result: LLMChatResult, request?: LLMRequestLogEntry): void;
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
  const toolExecutor = createAgentLoopToolExecutor({
    event: input.event,
    toolPlugins: input.toolPlugins,
    getLastCompletedToolName: input.getLastCompletedToolName,
    setLastCompletedToolName: input.setLastCompletedToolName
  });
  const visibleToolNames = input.llmInput.toolNames;
  let streamingToolSender: ReturnType<typeof createStreamingSendMessageHandler> | undefined;
  const spec: AgentFunctionCallLoopSpec = buildAgentFunctionCallLoopSpec({
    initialMessages: session.messages,
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
      streamingToolSender = createStreamingSendMessageHandler(input.event, toolExecutor.toolMap);
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
        streamHandlers: {
          onToolCallDelta(delta) {
            return streamingToolSender?.onToolCallDelta(delta);
          }
        }
      };
    },
    sendRequest: input.llmRequestSender ?? createChatLoopRequestSender({
      llm: input.llm,
      toolPlugins: input.toolPlugins,
      onLLMRequestPrepared: input.onLLMRequestPrepared,
      onLLMResponseReceived: input.onLLMResponseReceived,
      onLLMLog: input.onLLMLog
    }),
    async afterRequest() {
      await streamingToolSender?.finish();
    },
    shouldCancel() {
      return input.isLLMRunCancelled?.() === true;
    },
    async executeTool(call, { round, result }): Promise<AgentFunctionCallToolExecution> {
      const textVariables = input.buildTextVariables(input.event);
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
            yieldReturn: streamedResult.meta?.yieldReturn === true
          }
        };
      }
      const { result: toolResult, message: toolMessage } = await toolExecutor.executeLLMToolCall(call, {
        variables: textVariables,
        agentLoopRunSeq: input.agentLoopRunSeq,
        llmSessionId: session.id,
        llmCapabilities,
        transformInput: (toolName, toolInput) => fixedPrefixToolInput(toolName, toolInput, session)
      });
      const followup = buildToolFollowupLLMMessages(toolResult, llmCapabilities);
      if (followup.toolNotices.length > 0) {
        toolMessage.content = [toolMessage.content, ...followup.toolNotices].filter(Boolean).join("\n");
      }

      session.lastCheckChatCursorMessageId = checkChatCursorFromResult(call.function.name, toolResult) ?? session.lastCheckChatCursorMessageId;
      if (isWaitChatToolName(call.function.name) && toolResult.meta?.yieldReturn === true) {
        session.waitChatStartedAt = input.time.now().epochMs;
      }
      input.setLastCompletedToolName(call.function.name);
      const execution = resolveChatLoopToolControl({
        call,
        toolResult,
        toolMessage,
        session,
        llmResult: result,
        nowMs: input.time.now().epochMs,
        lastCheckChatCursorMessageId: session.lastCheckChatCursorMessageId
      });
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
        sentMessage: loopResult.sentMessage,
        invalidateSession: loopResult.invalidateSession,
        cancelled: loopResult.stopReason === "cancelled",
        finalResult: loopResult.finalResult
      };
    }
  };
}

export { runPromptToolRequest } from "./agent-loop-tool-executor.js";
export {
  buildFixedPrefixAppendMessages,
  buildWaitChatResumeMessages,
  checkChatCursorFromResult,
  cloneLLMMessages,
  defaultChatAgentModeState,
  estimateMessagesTokens,
  estimateTextTokens,
  findToolPlugin,
  toolResultText
} from "./chat-loop-session-context.js";

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

function formatToolResultForLLM(result: ToolResult, variables: LLMTextVariables = {}): string {
  return formatAgentLoopToolResultForLLM(result, variables);
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
