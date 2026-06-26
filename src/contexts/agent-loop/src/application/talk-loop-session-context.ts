import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { LLMMessage, LLMToolCall } from "../../../llm-gateway/src/index.js";
import type { AgentEvent, ToolCall, ToolPlugin, ToolResult, ToolExecutionContext } from "../contracts/agent-contracts.js";
import { prepareAgentLoopSessionContext, type AgentLoopMessagePatch, type AgentLoopPreparedSessionContext, type AgentLoopSessionContextInput, type AgentLoopTranscriptSession } from "../runtime/agent-loop-runtime.js";
import { createAgentLoopToolExecutor, formatAgentLoopToolResultForLLM } from "./agent-loop-tool-executor.js";
import { buildPromptMessagesWithToolResults, promptVariables, type PromptProfile, type PromptRenderContext } from "./prompts.js";

export type TalkLoopMessagePatch = AgentLoopMessagePatch;

export type TalkLoopRuntimeState = {
  conversationStartIndexes: Map<number, number>;
};

export type TalkLoopSessionContextDeps = {
  getTalkPromptProfile(): PromptProfile;
  time: CurrentTimeProvider;
  dailyShellStore: {
    render(date: Date, timeZone: string): string;
    get(date: Date, timeZone: string): PromptRenderContext["dailyShellRaw"];
  };
  getAppearanceDescription(): string | undefined;
  getLibrarySetting?(): string | undefined;
  memoryStore: { read(): PromptRenderContext["memory"] };
  diaryStore: { latestWakeBoundary(): PromptRenderContext["wakeBoundary"] };
  setLoopPrefixMessageCount(sessionId: number, count: number): void;
  buildNextLoopMessagePatch(sessionId: number, options?: { supportsAudio?: boolean }): Promise<TalkLoopMessagePatch> | TalkLoopMessagePatch;
  loadActiveTalkLLMSessionTranscript(): {
    id?: number;
    messages: LLMMessage[];
    staticPromptFingerprint?: string;
    staticPromptMessageCount?: number;
    requestTimestamps?: string[];
    agentLoopRunSeq?: number;
    lastTotalTokens?: number;
    lastInputTokens?: number;
    lastUsageModel?: string;
    mode?: string;
    lastCompletedToolName?: string;
  } | undefined;
  updateActiveTalkLLMSessionTranscript(session: {
    id?: number;
    messages: LLMMessage[];
    staticPromptFingerprint?: string;
    staticPromptMessageCount?: number;
    requestTimestamps?: string[];
    agentLoopRunSeq?: number;
    lastTotalTokens?: number;
    lastInputTokens?: number;
    lastUsageModel?: string;
    mode?: string;
    lastCompletedToolName?: string;
  }): void;
  prepareSessionContext?(input: AgentLoopSessionContextInput): Promise<AgentLoopPreparedSessionContext>;
  visibleToolNames(profile: PromptProfile): string[];
  toolPlugins: readonly ToolPlugin[];
  setLoopSessionState?(state: unknown | undefined): void;
};

export type TalkLoopPreparedSessionContext = {
  session: AgentLoopTranscriptSession;
  toolNames: string[];
  toolVariables: Record<string, unknown> | undefined;
  executeToolCall(call: LLMToolCall, input: {
    agentLoopRunSeq?: number;
    capabilities?: ToolExecutionContext["llmCapabilities"];
  }): Promise<TalkLoopExecutedToolCall>;
};

export type TalkLoopExecutedToolCall = {
  result: ToolResult;
  content: string;
};

export async function prepareTalkLoopSessionContext(input: {
  sessionId: number;
  state: TalkLoopRuntimeState;
  deps: TalkLoopSessionContextDeps;
  supportsAudio?: boolean;
}): Promise<TalkLoopPreparedSessionContext> {
  const { deps, sessionId, state } = input;
  const textSessionId = String(sessionId);
  const profile = deps.getTalkPromptProfile();
  const event = buildTalkAgentEvent(sessionId, deps.time);
  let session: AgentLoopTranscriptSession | undefined;
  const toolExecutor = createAgentLoopToolExecutor({
    event,
    toolPlugins: [...deps.toolPlugins],
    getLastCompletedToolName: () => session?.lastCompletedToolName,
    setLastCompletedToolName(name) {
      if (!session) return;
      session.lastCompletedToolName = name;
      deps.updateActiveTalkLLMSessionTranscript(session);
    }
  });
  const context = {
    event,
    time: deps.time,
    dailyShell: deps.dailyShellStore.render(deps.time.now().date, deps.time.timeZone),
    dailyShellRaw: deps.dailyShellStore.get(deps.time.now().date, deps.time.timeZone),
    appearanceDescription: deps.getAppearanceDescription(),
    librarySetting: deps.getLibrarySetting?.(),
    memory: deps.memoryStore.read(),
    wakeBoundary: deps.diaryStore.latestWakeBoundary()
  };
  const variables = promptVariables(profile, context);
  const runPromptTool = async (_layer: unknown, call: ToolCall) => toolExecutor.executeToolCall(call);
  const preparedSession = await (deps.prepareSessionContext ?? prepareAgentLoopSessionContext)({
    kind: "talk",
    sessionId: textSessionId,
    loadTranscript: deps.loadActiveTalkLLMSessionTranscript,
    buildInitialMessages: () => buildPromptMessagesWithToolResults(
      profile,
      context,
      runPromptTool as Parameters<typeof buildPromptMessagesWithToolResults>[2]
    ),
    buildMessagePatch: () => deps.buildNextLoopMessagePatch(sessionId, { supportsAudio: input.supportsAudio }),
    updateTranscript: deps.updateActiveTalkLLMSessionTranscript,
    onConversationStartIndex(prefixMessageCount) {
      state.conversationStartIndexes.set(sessionId, prefixMessageCount);
      deps.setLoopSessionState?.(state);
    },
    onPrefixMessageCount(prefixMessageCount) {
      deps.setLoopPrefixMessageCount(sessionId, prefixMessageCount);
    }
  });
  session = preparedSession.session;
  return {
    session: preparedSession.session,
    toolNames: deps.visibleToolNames(profile),
    toolVariables: variables,
    executeToolCall: (call: LLMToolCall, toolInput: { agentLoopRunSeq?: number; capabilities?: ToolExecutionContext["llmCapabilities"] }) => toolExecutor.executeLLMToolCall(call, {
      agentLoopRunSeq: toolInput.agentLoopRunSeq,
      llmSessionId: session?.id ?? sessionId,
      llmCapabilities: toolInput.capabilities
    })
      .then(({ result }) => ({ result, content: formatAgentLoopToolResultForLLM(result) }))
  };
}

export function buildTalkAgentEvent(sessionId: number, time: CurrentTimeProvider): AgentEvent {
  const now = time.now();
  const textSessionId = String(sessionId);
  return {
    id: `talk_${textSessionId}_${now.epochMs}`,
    source: {
      plugin: "webrtc_voice",
      channelId: textSessionId,
      userId: textSessionId
    },
    externalSession: {
      scope: "dm",
      sessionId: textSessionId
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

export function restoreTalkLoopRuntimeState(value: unknown): TalkLoopRuntimeState {
  if (isTalkLoopRuntimeState(value)) return value;
  return {
    conversationStartIndexes: new Map<number, number>()
  };
}

function isTalkLoopRuntimeState(value: unknown): value is TalkLoopRuntimeState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<TalkLoopRuntimeState>;
  return state.conversationStartIndexes instanceof Map;
}
