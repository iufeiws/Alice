import type { LLMToolCall } from "../../../llm-gateway/src/index.js";
import type { LLMRequestSender, LLMRequestSenderInput } from "../../../llm-gateway/src/llm-tool-loop.js";
import { buildAgentFunctionCallLoopSpec } from "./agent-function-call-loop.js";
import { type ChatAgentLoopInput, type ChatAgentLoopResult, type ChatAgentLoopSession } from "./run-chat-loop.js";
import { defaultTalkOutputReadyChars } from "../../../talk-session/src/application/talk-session-runtime.js";
import {
  type AgentFunctionCallLoopSpec,
  type AgentFunctionCallLoopResult,
  type AgentFunctionCallToolExecution,
  type AgentLoopTranscriptSession,
  type PreparedAgentLoopRun
} from "../runtime/agent-loop-runtime.js";
import {
  prepareTalkLoopSessionContext,
  restoreTalkLoopRuntimeState,
  type TalkLoopExecutedToolCall,
  type TalkLoopSessionContextDeps,
  type TalkLoopRuntimeState
} from "./talk-loop-session-context.js";
import { buildToolFollowupLLMMessages, type LLMCapabilityFlags } from "./tool-followup-messages.js";

export type TalkAgentLoopSession = ChatAgentLoopSession;
export type TalkAgentLoopInput = Omit<ChatAgentLoopInput, "llmInput"> & {
  llmInput: ChatAgentLoopInput["llmInput"];
};
export type TalkAgentLoopResult = ChatAgentLoopResult;

type TalkAgentLoopLogLevel = "info" | "warn" | "error";
type TalkAgentLoopLLMConfig = {
  client: NonNullable<LLMRequestSenderInput["client"]>;
  model?: string;
  temperature?: number;
  extraParams?: Record<string, unknown>;
  followupExtraParams?: Record<string, unknown>;
  presetName?: string;
  stream?: boolean;
  supportsImage?: boolean;
  supportsAudio?: boolean;
};

type TalkAgentLoopState = {
  toolNames: string[];
  toolVariables: Record<string, unknown> | undefined;
  executeToolCall(call: LLMToolCall, input: {
    currentRound: number;
    capabilities?: LLMCapabilityFlags;
  }): Promise<TalkLoopExecutedToolCall>;
};

type TalkAgentLoopDeps = TalkLoopSessionContextDeps & {
  isActiveTalkLLMSession(sessionId: number): boolean;
  getActiveTalkLLMSessionId(): number | undefined;
  isTalkSessionOpen(sessionId: number): boolean;
  pendingVoiceOutputCharCount(sessionId: number): number;
  isForegroundPlaybackIdle(sessionId: number): boolean;
  maxPendingVoiceOutputChars?: number;
  getLLMConfig(): TalkAgentLoopLLMConfig;
  sendRequest: LLMRequestSender;
  getLoopSessionState?(): unknown;
  appendAssistantDelta(input: { sessionId: string; outputId: string; delta: string }): void;
  finishAssistantOutput(input: { sessionId: string; outputId: string }): void;
  log(level: TalkAgentLoopLogLevel, message: string): void;
};

export type TalkAgentLoopController = {
  prepareTalkAgentLoopForSession(sessionId: number, options?: { signal?: AbortSignal }): Promise<PreparedAgentLoopRun | undefined>;
  interruptTalkAgentLoop(sessionId: number): void;
  getConversationStartIndex(sessionId: number): number | undefined;
};

export type PreparedTalkAgentLoop = {
  spec: AgentFunctionCallLoopSpec;
  complete(result: AgentFunctionCallLoopResult): void;
};

export function createTalkAgentLoopForSession(deps: TalkAgentLoopDeps): TalkAgentLoopController {
  const state = restoreTalkLoopRuntimeState(deps.getLoopSessionState?.());
  deps.setLoopSessionState?.(state);
  const maxPendingVoiceOutputChars = deps.maxPendingVoiceOutputChars ?? defaultTalkOutputReadyChars;

  async function prepareTalkAgentLoopForSession(sessionId: number, options: { signal?: AbortSignal } = {}): Promise<PreparedAgentLoopRun | undefined> {
    if (!deps.isActiveTalkLLMSession(sessionId)) {
      deps.log("warn", `talk loop skipped: session id mismatch session=${sessionId} active=${deps.getActiveTalkLLMSessionId() ?? "none"}`);
      return;
    }
    if (!deps.isTalkSessionOpen(sessionId)) {
      deps.log("info", `talk loop skipped: session closed session=${sessionId}`);
      return;
    }
    try {
      deps.log("info", `talk loop start: session=${sessionId}`);
      const { session, toolNames, toolVariables, executeToolCall } = await buildTalkAgentLoopState(sessionId);
      const config = deps.getLLMConfig();
      if (!canStartTalkLoop(sessionId, options.signal)) return;
      const prepared = buildTalkAgentLoopSpec({
        sessionId,
        session,
        toolNames,
        toolVariables,
        executeToolCall,
        config,
        signal: options.signal
      });
      return {
        spec: prepared.spec,
        complete(result) {
          prepared.complete(result);
          return [];
        },
        onError(error) {
          if (options.signal?.aborted || isCancellationError(error)) {
            deps.log("info", `talk loop cancelled: session=${sessionId} reason=${error instanceof Error ? error.message : String(error)}`);
            return;
          }
          deps.log("error", `talk loop failed: session=${sessionId} error=${error instanceof Error ? error.message : String(error)}`);
        },
        dispose() {}
      };
    } catch (error) {
      if (options.signal?.aborted || isCancellationError(error)) {
        deps.log("info", `talk loop cancelled: session=${sessionId} reason=${error instanceof Error ? error.message : String(error)}`);
      } else {
        deps.log("error", `talk loop failed: session=${sessionId} error=${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  function buildTalkAgentLoopSpec(input: {
    sessionId: number;
    session: AgentLoopTranscriptSession;
    toolNames: string[];
    toolVariables: Record<string, unknown> | undefined;
    executeToolCall(call: LLMToolCall, input: {
      currentRound: number;
      capabilities?: LLMCapabilityFlags;
    }): Promise<TalkLoopExecutedToolCall>;
    config: TalkAgentLoopLLMConfig;
    signal?: AbortSignal;
  }): PreparedTalkAgentLoop {
    const roundOutputs = new Map<number, { outputId: string; streamedContent: string }>();
    const sessionRounds = new Map<number, number>();
    const spec: AgentFunctionCallLoopSpec = buildAgentFunctionCallLoopSpec({
      initialMessages: input.session.messages,
      buildRequest({ round, messages }) {
        input.session.currentRound = (input.session.currentRound ?? -1) + 1;
        sessionRounds.set(round, input.session.currentRound);
        const outputId = `talk:${input.sessionId}:${Date.now()}:${round}`;
        roundOutputs.set(round, { outputId, streamedContent: "" });
        return {
          agentId: "talk",
          client: input.config.client,
          messages,
          model: input.config.model,
          temperature: input.config.temperature,
          extraParams: input.config.extraParams,
          presetName: input.config.presetName,
          toolNames: input.toolNames,
          toolVariables: input.toolVariables,
          stream: input.config.stream !== false,
          signal: input.signal,
          streamHandlers: {
            onContentDelta(delta) {
              const output = roundOutputs.get(round);
              if (output) output.streamedContent += delta;
              deps.appendAssistantDelta({ sessionId: String(input.sessionId), outputId, delta });
            }
          }
        };
      },
      sendRequest: deps.sendRequest,
      async executeTool(call, { round }): Promise<AgentFunctionCallToolExecution> {
        const capabilities: LLMCapabilityFlags = {
          supportsImage: input.config.supportsImage,
          supportsAudio: input.config.supportsAudio
        };
        const executed = await input.executeToolCall(call, {
          currentRound: sessionRounds.get(round) ?? round,
          capabilities
        });
        const followup = buildToolFollowupLLMMessages(executed.result, capabilities);
        const content = followup.toolNotices.length > 0
          ? [executed.content, ...followup.toolNotices].filter(Boolean).join("\n")
          : executed.content;
        return {
          message: {
            role: "tool" as const,
            toolCallId: call.id,
            name: call.function.name,
            content
          },
          messages: followup.messages
        };
      },
      afterRequest({ round, result }) {
        const output = roundOutputs.get(round);
        if (!output) return;
        const { outputId, streamedContent } = output;
        if (!streamedContent && typeof result.message.content === "string" && result.message.content) {
          deps.appendAssistantDelta({ sessionId: String(input.sessionId), outputId, delta: result.message.content });
        }
        if (streamedContent || result.message.content) {
          deps.finishAssistantOutput({ sessionId: String(input.sessionId), outputId });
          deps.log("info", `talk loop output ready: session=${input.sessionId} output=${outputId}`);
        }
      }
    });
    return {
      spec,
      complete(result) {
        input.session.messages = result.messages;
        deps.updateActiveTalkLLMSessionTranscript(input.session);
      }
    };
  }

  function interruptTalkAgentLoop(sessionId: number): void {
    deps.log("info", `talk loop interrupt requested: session=${sessionId}`);
  }

  function getConversationStartIndex(sessionId: number): number | undefined {
    return state.conversationStartIndexes.get(sessionId);
  }

  function canStartTalkLoop(sessionId: number, signal?: AbortSignal): boolean {
    if (signal?.aborted) {
      deps.log("info", `talk loop cancelled before request: session=${sessionId}`);
      return false;
    }
    if (!deps.isActiveTalkLLMSession(sessionId)) {
      deps.log("warn", `talk loop stopped: session id mismatch session=${sessionId} active=${deps.getActiveTalkLLMSessionId() ?? "none"}`);
      return false;
    }
    if (!deps.isTalkSessionOpen(sessionId)) {
      deps.log("info", `talk loop stopped: session closed session=${sessionId}`);
      return false;
    }
    const pendingChars = deps.pendingVoiceOutputCharCount(sessionId);
    const foregroundPlaybackIdle = deps.isForegroundPlaybackIdle(sessionId);
    if (pendingChars === 0 && foregroundPlaybackIdle) return true;
    deps.log("info", `talk loop not ready: voice output pending_chars=${pendingChars} foreground_idle=${foregroundPlaybackIdle} limit=${maxPendingVoiceOutputChars} session=${sessionId}`);
    return false;
  }

  async function buildTalkAgentLoopState(sessionId: number): Promise<TalkAgentLoopState & { session: AgentLoopTranscriptSession }> {
    return prepareTalkLoopSessionContext({
      sessionId,
      state,
      deps
    });
  }

  return {
    prepareTalkAgentLoopForSession,
    interruptTalkAgentLoop,
    getConversationStartIndex
  };
}

function isCancellationError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return message === "llm_request_cancelled" || /abort/i.test(message);
}
