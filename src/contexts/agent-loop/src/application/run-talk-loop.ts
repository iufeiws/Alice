import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { LLMMessage, LLMToolCall } from "../../../llm-gateway/src/index.js";
import type { LLMRequestSender, LLMRequestSenderInput } from "../../../llm-gateway/src/llm-tool-loop.js";
import type { AgentEvent, ToolCall, ToolPlugin, ToolResult } from "../contracts/agent-contracts.js";
import { buildPromptMessagesWithToolResults, promptVariables, type PromptProfile, type PromptRenderContext } from "./prompts.js";
import { formatToolResultForLLM } from "../../../../contexts/agent-profile/src/application/llm-text-renderer.js";
import { runChatAgentLoop, type ChatAgentLoopInput, type ChatAgentLoopResult, type ChatAgentLoopSession } from "./run-chat-loop.js";
import { defaultTalkOutputReadyChars } from "../../../talk-session/src/application/talk-session-runtime.js";
import {
  prepareAgentLoopSessionContext,
  runAgentFunctionCallLoop,
  type AgentFunctionCallLoopSpec,
  type AgentFunctionCallLoopResult,
  type AgentFunctionCallToolExecution,
  type AgentLoopMessagePatch,
  type AgentLoopPreparedSessionContext,
  type AgentLoopSessionContextInput,
  type AgentLoopTranscriptSession,
  type PreparedAgentLoopRun
} from "../runtime/agent-loop-runtime.js";

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
  stream?: boolean;
};

type TalkAgentLoopState = {
  toolNames: string[];
  toolVariables: Record<string, unknown> | undefined;
  executeToolCall(call: LLMToolCall): Promise<string>;
};

type TalkLoopMessagePatch = AgentLoopMessagePatch;

type TalkLoopRuntimeState = {
  activeLoops: Set<string>;
  controllers: Map<string, AbortController>;
  conversationStartIndexes: Map<string, number>;
};

type TalkAgentLoopDeps = {
  isActiveTalkLLMSession(sessionId: string): boolean;
  getActiveTalkLLMSessionId(): string | number | undefined;
  isTalkSessionOpen(sessionId: string): boolean;
  pendingVoiceOutputCharCount(sessionId: string): number;
  isForegroundPlaybackIdle(sessionId: string): boolean;
  getTalkPromptProfile(): PromptProfile;
  time: CurrentTimeProvider;
  dailyShellStore: {
    render(date: Date, timeZone: string): string;
    get(date: Date, timeZone: string): PromptRenderContext["dailyShellRaw"];
  };
  getAppearanceDescription(): string | undefined;
  memoryStore: { read(): PromptRenderContext["memory"] };
  diaryStore: { latestWakeBoundary(): PromptRenderContext["wakeBoundary"] };
  setLoopPrefixMessageCount(sessionId: string, count: number): void;
  buildNextLoopMessagePatch(sessionId: string): Promise<TalkLoopMessagePatch> | TalkLoopMessagePatch;
  loadActiveTalkLLMSessionTranscript(): {
    messages: LLMMessage[];
    staticPromptFingerprint?: string;
    staticPromptMessageCount?: number;
    requestTimestamps?: string[];
    lastTotalTokens?: number;
    lastInputTokens?: number;
    lastUsageModel?: string;
    mode?: string;
  } | undefined;
  updateActiveTalkLLMSessionTranscript(session: {
    messages: LLMMessage[];
    staticPromptFingerprint?: string;
    staticPromptMessageCount?: number;
    requestTimestamps?: string[];
    lastTotalTokens?: number;
    lastInputTokens?: number;
    lastUsageModel?: string;
    mode?: string;
  }): void;
  prepareSessionContext?(input: AgentLoopSessionContextInput): Promise<AgentLoopPreparedSessionContext>;
  maxPendingVoiceOutputChars?: number;
  visibleToolNames(profile: PromptProfile): string[];
  toolPlugins: readonly ToolPlugin[];
  getLLMConfig(): TalkAgentLoopLLMConfig;
  sendRequest: LLMRequestSender;
  runFunctionCallLoop?(spec: AgentFunctionCallLoopSpec): Promise<AgentFunctionCallLoopResult>;
  getLoopSessionState?(): unknown;
  setLoopSessionState?(state: unknown | undefined): void;
  appendAssistantDelta(input: { sessionId: string; outputId: string; delta: string }): void;
  finishAssistantOutput(input: { sessionId: string; outputId: string }): void;
  log(level: TalkAgentLoopLogLevel, message: string): void;
  sleep?(ms: number): Promise<void>;
};

export type TalkAgentLoopController = {
  prepareTalkAgentLoopForSession(sessionId: string): Promise<PreparedAgentLoopRun | undefined>;
  runTalkAgentLoopForSession(sessionId: string): Promise<void>;
  interruptTalkAgentLoop(sessionId: string): void;
  getConversationStartIndex(sessionId: string): number | undefined;
};

export type PreparedTalkAgentLoop = {
  spec: AgentFunctionCallLoopSpec;
  complete(result: AgentFunctionCallLoopResult): void;
};

export function createTalkAgentLoopForSession(deps: TalkAgentLoopDeps): TalkAgentLoopController {
  const state = restoreTalkLoopRuntimeState(deps.getLoopSessionState?.());
  deps.setLoopSessionState?.(state);
  const maxPendingVoiceOutputChars = deps.maxPendingVoiceOutputChars ?? defaultTalkOutputReadyChars;

  async function prepareTalkAgentLoopForSession(sessionId: string): Promise<PreparedAgentLoopRun | undefined> {
    if (state.activeLoops.has(sessionId)) return;
    if (!deps.isActiveTalkLLMSession(sessionId)) {
      deps.log("warn", `talk loop skipped: session id mismatch session=${sessionId} active=${deps.getActiveTalkLLMSessionId() ?? "none"}`);
      return;
    }
    if (!deps.isTalkSessionOpen(sessionId)) {
      deps.log("info", `talk loop skipped: session closed session=${sessionId}`);
      return;
    }
    state.activeLoops.add(sessionId);
    const controller = new AbortController();
    state.controllers.set(sessionId, controller);
    deps.setLoopSessionState?.(state);
    try {
      deps.log("info", `talk loop start: session=${sessionId}`);
      const { session, toolNames, toolVariables, executeToolCall } = await buildTalkAgentLoopState(sessionId);
      const config = deps.getLLMConfig();
      const guard = await waitForTalkLoopRound(sessionId, 0, controller);
      if (!guard.continue) {
        cleanupTalkAgentLoop(sessionId, controller);
        return;
      }
      const prepared = buildTalkAgentLoopSpec({
        sessionId,
        session,
        toolNames,
        toolVariables,
        executeToolCall,
        config,
        controller
      });
      return {
        spec: prepared.spec,
        complete(result) {
          prepared.complete(result);
          return [];
        },
        onError(error) {
          if (controller.signal.aborted || isCancellationError(error)) {
            deps.log("info", `talk loop cancelled: session=${sessionId} reason=${error instanceof Error ? error.message : String(error)}`);
            return;
          }
          deps.log("error", `talk loop failed: session=${sessionId} error=${error instanceof Error ? error.message : String(error)}`);
        },
        dispose() {
          cleanupTalkAgentLoop(sessionId, controller);
        }
      };
    } catch (error) {
      if (controller.signal.aborted || isCancellationError(error)) {
        deps.log("info", `talk loop cancelled: session=${sessionId} reason=${error instanceof Error ? error.message : String(error)}`);
      } else {
        deps.log("error", `talk loop failed: session=${sessionId} error=${error instanceof Error ? error.message : String(error)}`);
      }
      cleanupTalkAgentLoop(sessionId, controller);
    }
  }

  async function runTalkAgentLoopForSession(sessionId: string): Promise<void> {
    const prepared = await prepareTalkAgentLoopForSession(sessionId);
    if (!prepared) return;
    try {
      const spec = await Promise.resolve(prepared.prepare ? prepared.prepare() : prepared.spec);
      if (!spec || Array.isArray(spec)) return;
      prepared.complete(await (deps.runFunctionCallLoop ?? runAgentFunctionCallLoop)(spec));
    } catch (error) {
      await prepared.onError?.(error);
    } finally {
      await prepared.dispose?.();
    }
  }

  function cleanupTalkAgentLoop(sessionId: string, controller: AbortController): void {
    if (state.controllers.get(sessionId) === controller) {
      state.controllers.delete(sessionId);
    }
    state.activeLoops.delete(sessionId);
    deps.setLoopSessionState?.(state);
  }

  function buildTalkAgentLoopSpec(input: {
    sessionId: string;
    session: AgentLoopTranscriptSession;
    toolNames: string[];
    toolVariables: Record<string, unknown> | undefined;
    executeToolCall(call: LLMToolCall): Promise<string>;
    config: TalkAgentLoopLLMConfig;
    controller: AbortController;
  }): PreparedTalkAgentLoop {
    const roundOutputs = new Map<number, { outputId: string; streamedContent: string }>();
    const spec: AgentFunctionCallLoopSpec = {
      initialMessages: input.session.messages,
      limits: { maxRounds: 20, maxTotalToolCalls: 20, maxRepeatedToolCalls: 3 },
      buildRequest({ round, messages }) {
        const outputId = `talk:${input.sessionId}:${Date.now()}:${round}`;
        roundOutputs.set(round, { outputId, streamedContent: "" });
        return {
          agentId: "talk",
          client: input.config.client,
          messages,
          model: input.config.model,
          temperature: input.config.temperature,
          extraParams: input.config.extraParams,
          toolNames: input.toolNames,
          toolVariables: input.toolVariables,
          stream: input.config.stream !== false,
          signal: input.controller.signal,
          streamHandlers: {
            onContentDelta(delta) {
              const output = roundOutputs.get(round);
              if (output) output.streamedContent += delta;
              deps.appendAssistantDelta({ sessionId: input.sessionId, outputId, delta });
            }
          }
        };
      },
      sendRequest: deps.sendRequest,
      async executeTool(call): Promise<AgentFunctionCallToolExecution> {
        return {
          message: {
            role: "tool" as const,
            toolCallId: call.id,
            name: call.function.name,
            content: await input.executeToolCall(call)
          }
        };
      },
      afterRequest({ round, result }) {
        const output = roundOutputs.get(round);
        if (!output) return;
        const { outputId, streamedContent } = output;
        if (!streamedContent && result.message.content) {
          deps.appendAssistantDelta({ sessionId: input.sessionId, outputId, delta: result.message.content });
        }
        if (streamedContent || result.message.content) {
          deps.finishAssistantOutput({ sessionId: input.sessionId, outputId });
          deps.log("info", `talk loop output ready: session=${input.sessionId} output=${outputId}`);
        }
      }
    };
    return {
      spec,
      complete(result) {
        input.session.messages = result.messages;
        deps.updateActiveTalkLLMSessionTranscript(input.session);
      }
    };
  }

  function interruptTalkAgentLoop(sessionId: string): void {
    state.controllers.get(sessionId)?.abort();
  }

  function getConversationStartIndex(sessionId: string): number | undefined {
    return state.conversationStartIndexes.get(sessionId);
  }

  async function waitForTalkLoopRound(sessionId: string, round: number, controller: AbortController): Promise<{ continue: boolean }> {
    let loggedBackpressure = false;
    while (true) {
      if (controller.signal.aborted) {
        deps.log("info", `talk loop cancelled before round: session=${sessionId} round=${round}`);
        return { continue: false };
      }
      if (!deps.isActiveTalkLLMSession(sessionId)) {
        deps.log("warn", `talk loop stopped: session id mismatch session=${sessionId} active=${deps.getActiveTalkLLMSessionId() ?? "none"}`);
        return { continue: false };
      }
      if (!deps.isTalkSessionOpen(sessionId)) {
        deps.log("info", `talk loop stopped: session closed session=${sessionId}`);
        return { continue: false };
      }
      const pendingChars = deps.pendingVoiceOutputCharCount(sessionId);
      const foregroundPlaybackIdle = deps.isForegroundPlaybackIdle(sessionId);
      if (pendingChars === 0 && foregroundPlaybackIdle) return { continue: true };
      if (!loggedBackpressure) {
        deps.log("info", `talk loop waiting: voice output pending_chars=${pendingChars} foreground_idle=${foregroundPlaybackIdle} limit=${maxPendingVoiceOutputChars} session=${sessionId}`);
        loggedBackpressure = true;
      }
      await (deps.sleep ?? sleep)(25);
    }
  }

  async function buildTalkAgentLoopState(sessionId: string): Promise<TalkAgentLoopState & { session: AgentLoopTranscriptSession }> {
    const profile = deps.getTalkPromptProfile();
    const event = buildTalkAgentEvent(sessionId, deps.time);
    const context = {
      event,
      time: deps.time,
      dailyShell: deps.dailyShellStore.render(deps.time.now().date, deps.time.timeZone),
      dailyShellRaw: deps.dailyShellStore.get(deps.time.now().date, deps.time.timeZone),
      appearanceDescription: deps.getAppearanceDescription(),
      memory: deps.memoryStore.read(),
      wakeBoundary: deps.diaryStore.latestWakeBoundary()
    };
    const variables = promptVariables(profile, context);
    const runPromptTool = async (_layer: unknown, call: ToolCall) => executeTalkToolCall(context.event, call, variables);
    const preparedSession = await (deps.prepareSessionContext ?? prepareAgentLoopSessionContext)({
      kind: "talk",
      sessionId,
      loadTranscript: deps.loadActiveTalkLLMSessionTranscript,
      buildInitialMessages: () => buildPromptMessagesWithToolResults(
        profile,
        context,
        runPromptTool as Parameters<typeof buildPromptMessagesWithToolResults>[2]
      ),
      buildMessagePatch: () => deps.buildNextLoopMessagePatch(sessionId),
      updateTranscript: deps.updateActiveTalkLLMSessionTranscript,
      onConversationStartIndex(prefixMessageCount) {
        state.conversationStartIndexes.set(sessionId, prefixMessageCount);
        deps.setLoopSessionState?.(state);
      },
      onPrefixMessageCount(prefixMessageCount) {
        deps.setLoopPrefixMessageCount(sessionId, prefixMessageCount);
      }
    });
    return {
      session: preparedSession.session,
      toolNames: deps.visibleToolNames(profile),
      toolVariables: variables,
      executeToolCall: (call: LLMToolCall) => executeTalkLLMToolCall(event, call)
        .then((result) => formatToolResultForLLM(result))
    };
  }

  async function executeTalkLLMToolCall(event: AgentEvent, call: LLMToolCall): Promise<ToolResult> {
    return executeTalkToolCall(event, {
      id: call.id,
      toolName: call.function.name,
      input: parseToolArguments(call.function.arguments)
    }, promptVariables(deps.getTalkPromptProfile(), {
      event,
      time: deps.time,
      dailyShell: deps.dailyShellStore.render(deps.time.now().date, deps.time.timeZone),
      dailyShellRaw: deps.dailyShellStore.get(deps.time.now().date, deps.time.timeZone),
      appearanceDescription: deps.getAppearanceDescription(),
      memory: deps.memoryStore.read(),
      wakeBoundary: deps.diaryStore.latestWakeBoundary()
    }));
  }

  async function executeTalkToolCall(
    _event: AgentEvent,
    call: ToolCall,
    _variables: ReturnType<typeof promptVariables>
  ): Promise<ToolResult> {
    const plugin = deps.toolPlugins.find((entry) => entry.listTools().some((tool) => tool.name === call.toolName));
    if (!plugin) {
      return {
        callId: call.id,
        ok: false,
        error: `Unknown tool: ${call.toolName}`
      };
    }
    try {
      return await plugin.execute({
        id: call.id,
        toolName: call.toolName,
        input: call.input,
        requester: _event.source,
        session: _event.session
      });
    } catch (error) {
      return {
        callId: call.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  return {
    prepareTalkAgentLoopForSession,
    runTalkAgentLoopForSession,
    interruptTalkAgentLoop,
    getConversationStartIndex
  };
}

function normalizeMaxContinuousRounds(value: unknown): number {
  const rounds = Number(value);
  if (!Number.isFinite(rounds) || rounds < 1) return 30;
  return Math.max(1, Math.floor(rounds));
}

function isCancellationError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return message === "llm_request_cancelled" || /abort/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildTalkAgentEvent(sessionId: string, time: CurrentTimeProvider): AgentEvent {
  const now = time.now();
  return {
    id: `talk_${sessionId}_${now.epochMs}`,
    source: {
      plugin: "webrtc_voice",
      channelId: sessionId,
      userId: sessionId
    },
    session: {
      scope: "dm",
      sessionId
    },
    type: "message.text",
    payload: {
      kind: "text",
      text: "A realtime voice call event was received."
    },
    meta: {
      receivedAt: now.iso,
      receivedAtUtc: now.date.toISOString()
    }
  } as const;
}

function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function runTalkAgentLoop(input: TalkAgentLoopInput): Promise<TalkAgentLoopResult> {
  return runChatAgentLoop({
    ...input,
    llmInput: {
      ...input.llmInput,
      agentId: "talk"
    }
  });
}

function restoreTalkLoopRuntimeState(value: unknown): TalkLoopRuntimeState {
  if (isTalkLoopRuntimeState(value)) return value;
  return {
    activeLoops: new Set<string>(),
    controllers: new Map<string, AbortController>(),
    conversationStartIndexes: new Map<string, number>()
  };
}

function isTalkLoopRuntimeState(value: unknown): value is TalkLoopRuntimeState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<TalkLoopRuntimeState>;
  return state.activeLoops instanceof Set
    && state.controllers instanceof Map
    && state.conversationStartIndexes instanceof Map;
}
