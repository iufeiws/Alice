import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { LLMMessage } from "../../../llm-gateway/src/index.js";
import type { PromptContextRuntime } from "../../../prompt-context/src/index.js";
import type { AgentEvent, ToolCall, ToolPlugin } from "../contracts/agent-contracts.js";
import { prepareAgentLoopSessionContext, type AgentLoopMessagePatch, type AgentLoopPreparedSessionContext, type AgentLoopSessionContextInput, type AgentLoopTranscriptSession } from "../runtime/agent-loop-runtime.js";
import { createAgentLoopToolExecutor } from "./agent-loop-tool-executor.js";
import { buildPromptMessagesWithToolResults, promptRenderer, type PromptProfile, type PromptRenderContext } from "./prompts.js";

export type TalkLoopMessagePatch = AgentLoopMessagePatch;

export type TalkLoopRuntimeState = {
  conversationStartIndexes: Map<number, number>;
};

export type TalkLoopSessionContextDeps = {
  getTalkPromptProfile(): PromptProfile;
  time: CurrentTimeProvider;
  getPromptRenderer(): PromptContextRuntime;
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
};

export type TalkLoopPreparedSessionContext = {
  session: AgentLoopTranscriptSession;
  promptProfile: PromptProfile;
  toolNames: string[];
  toolVariables: PromptContextRuntime | undefined;
  event: AgentEvent;
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
    renderer: requirePromptRenderer(deps),
    event,
    time: deps.time
  };
  const renderer = promptRenderer(context);
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
    },
    onPrefixMessageCount(prefixMessageCount) {
      deps.setLoopPrefixMessageCount(sessionId, prefixMessageCount);
    }
  });
  session = preparedSession.session;
  return {
    session: preparedSession.session,
    promptProfile: profile,
    toolNames: deps.visibleToolNames(profile),
    toolVariables: renderer,
    event
  };
}

function requirePromptRenderer(deps: TalkLoopSessionContextDeps): PromptContextRuntime {
  return deps.getPromptRenderer();
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
