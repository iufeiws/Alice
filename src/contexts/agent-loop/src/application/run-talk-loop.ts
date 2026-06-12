import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { LLMMessage, LLMToolCall } from "../../../llm-gateway/src/index.js";
import type { LLMRequestSender, LLMRequestSenderInput } from "../../../llm-gateway/src/llm-tool-loop.js";
import type { AgentEvent, ToolCall, ToolPlugin, ToolResult } from "../contracts/agent-contracts.js";
import { buildPromptMessagesWithToolResults, promptVariables, type PromptProfile, type PromptRenderContext } from "./prompts.js";
import { formatToolResultForLLM } from "../../../../contexts/agent-profile/src/application/llm-text-renderer.js";
import { runChatAgentLoop, type ChatAgentLoopInput, type ChatAgentLoopResult, type ChatAgentLoopSession } from "./run-chat-loop.js";
import { defaultTalkOutputReadyChars } from "../../../talk-session/src/application/talk-session-runtime.js";
import { runAgentLoopExecutionSpec, type AgentLoopExecutionSpec, type AgentLoopToolExecution } from "./agent-loop-executor.js";

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

type TalkLoopMessagePatch = {
  replaceFrom: number;
  messages: LLMMessage[];
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
  maxPendingVoiceOutputChars?: number;
  visibleToolNames(profile: PromptProfile): string[];
  toolPlugins: readonly ToolPlugin[];
  getLLMConfig(): TalkAgentLoopLLMConfig;
  sendRequest: LLMRequestSender;
  appendAssistantDelta(input: { sessionId: string; outputId: string; delta: string }): void;
  finishAssistantOutput(input: { sessionId: string; outputId: string }): void;
  log(level: TalkAgentLoopLogLevel, message: string): void;
  sleep?(ms: number): Promise<void>;
};

export type TalkAgentLoopController = {
  runTalkAgentLoopForSession(sessionId: string): Promise<void>;
  interruptTalkAgentLoop(sessionId: string): void;
  getConversationStartIndex(sessionId: string): number | undefined;
};

export function createTalkAgentLoopForSession(deps: TalkAgentLoopDeps): TalkAgentLoopController {
  const activeTalkAgentLoops = new Set<string>();
  const activeTalkAgentLoopControllers = new Map<string, AbortController>();
  const activeTalkConversationStartIndexes = new Map<string, number>();
  const maxPendingVoiceOutputChars = deps.maxPendingVoiceOutputChars ?? defaultTalkOutputReadyChars;

  async function runTalkAgentLoopForSession(sessionId: string): Promise<void> {
    if (activeTalkAgentLoops.has(sessionId)) return;
    if (!deps.isActiveTalkLLMSession(sessionId)) {
      deps.log("warn", `talk loop skipped: session id mismatch session=${sessionId} active=${deps.getActiveTalkLLMSessionId() ?? "none"}`);
      return;
    }
    if (!deps.isTalkSessionOpen(sessionId)) {
      deps.log("info", `talk loop skipped: session closed session=${sessionId}`);
      return;
    }
    activeTalkAgentLoops.add(sessionId);
    const controller = new AbortController();
    activeTalkAgentLoopControllers.set(sessionId, controller);
    try {
      deps.log("info", `talk loop start: session=${sessionId}`);
      const { session, toolNames, toolVariables, executeToolCall } = await buildTalkAgentLoopState(sessionId);
      const config = deps.getLLMConfig();
      const guard = await waitForTalkLoopRound(sessionId, 0, controller);
      if (!guard.continue) return;
      const roundOutputs = new Map<number, { outputId: string; streamedContent: string }>();
      const spec: AgentLoopExecutionSpec = {
        initialMessages: session.messages,
        limits: { maxRounds: 20, maxTotalToolCalls: 20, maxRepeatedToolCalls: 3 },
        buildRequest({ round, messages }) {
          const outputId = `talk:${sessionId}:${Date.now()}:${round}`;
          roundOutputs.set(round, { outputId, streamedContent: "" });
          return {
            agentId: "talk",
            client: config.client,
            messages,
            model: config.model,
            temperature: config.temperature,
            extraParams: config.extraParams,
            toolNames,
            toolVariables,
            stream: config.stream !== false,
            signal: controller.signal,
            streamHandlers: {
              onContentDelta(delta) {
                const output = roundOutputs.get(round);
                if (output) output.streamedContent += delta;
                deps.appendAssistantDelta({ sessionId, outputId, delta });
              }
            }
          };
        },
        sendRequest: deps.sendRequest,
        async executeTool(call): Promise<AgentLoopToolExecution> {
          return {
            message: {
              role: "tool" as const,
              toolCallId: call.id,
              name: call.function.name,
              content: await executeToolCall(call)
            }
          };
        },
        afterRequest({ round, result }) {
          const output = roundOutputs.get(round);
          if (!output) return;
          const { outputId, streamedContent } = output;
          if (!streamedContent && result.message.content) {
            deps.appendAssistantDelta({ sessionId, outputId, delta: result.message.content });
          }
          if (streamedContent || result.message.content) {
            deps.finishAssistantOutput({ sessionId, outputId });
            deps.log("info", `talk loop output ready: session=${sessionId} output=${outputId}`);
          }
        }
      };
      const result = await runAgentLoopExecutionSpec(spec);
      session.messages = result.messages;
      deps.updateActiveTalkLLMSessionTranscript(session);
    } catch (error) {
      if (controller.signal.aborted || isCancellationError(error)) {
        deps.log("info", `talk loop cancelled: session=${sessionId} reason=${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      deps.log("error", `talk loop failed: session=${sessionId} error=${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (activeTalkAgentLoopControllers.get(sessionId) === controller) {
        activeTalkAgentLoopControllers.delete(sessionId);
      }
      activeTalkAgentLoops.delete(sessionId);
    }
  }

  function interruptTalkAgentLoop(sessionId: string): void {
    activeTalkAgentLoopControllers.get(sessionId)?.abort();
  }

  function getConversationStartIndex(sessionId: string): number | undefined {
    return activeTalkConversationStartIndexes.get(sessionId);
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

  async function buildTalkAgentLoopState(sessionId: string): Promise<TalkAgentLoopState & { session: {
    messages: LLMMessage[];
    staticPromptFingerprint?: string;
    staticPromptMessageCount?: number;
    requestTimestamps?: string[];
    lastTotalTokens?: number;
    lastInputTokens?: number;
    lastUsageModel?: string;
    mode?: string;
  } }> {
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
    let session = deps.loadActiveTalkLLMSessionTranscript();
    if (!session || session.messages.length === 0) {
      const promptMessages: LLMMessage[] = await buildPromptMessagesWithToolResults(profile, context, runPromptTool as Parameters<typeof buildPromptMessagesWithToolResults>[2]);
      session = {
        messages: promptMessages,
        staticPromptFingerprint: "talk",
        staticPromptMessageCount: promptMessages.length,
        requestTimestamps: [],
        mode: "normal"
      };
      deps.updateActiveTalkLLMSessionTranscript(session);
    }
    const prefixMessageCount = session.staticPromptMessageCount ?? session.messages.length;
    activeTalkConversationStartIndexes.set(sessionId, prefixMessageCount);
    deps.setLoopPrefixMessageCount(sessionId, prefixMessageCount);
    const patch = await Promise.resolve(deps.buildNextLoopMessagePatch(sessionId));
    session = {
      ...session,
      messages: [
        ...session.messages.slice(0, patch.replaceFrom),
        ...patch.messages
      ]
    };
    deps.updateActiveTalkLLMSessionTranscript(session);
    return {
      session,
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
