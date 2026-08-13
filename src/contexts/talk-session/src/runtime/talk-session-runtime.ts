import { createTalkAgentLoopForSession } from "../../../agent-loop/src/application/run-talk-loop.js";
import type { AliceStore } from "../../../conversation-hub/src/ports/conversation-store.js";
import { createTalkStore } from "../adapters/sqlite-talk-session-store.js";
import type { TalkSession } from "../adapters/sqlite-talk-session-store.js";
import { createTalkRuntime } from "../application/talk-session-runtime.js";
import type { PromptContextRuntime } from "../../../prompt-context/src/index.js";

const path = await import("node:path");

export function createTalkRuntimeRuntime(input: {
  isActiveTalkLLMSession(sessionId: number): boolean;
  getCurrentTalkLLMSessionId(): number | undefined;
  getTalkPromptProfile(): any;
  time: any;
  getPromptRenderer(): PromptContextRuntime;
  visibleToolNames(profile: any): string[];
  toolPlugins: any[];
  getLLMConfig(): any;
  sendRequest(input: any): Promise<any>;
  /** response 消息格式化完成后的递交钩子(llm-requests 的 flushResponseTranscript)。 */
  flushResponseTranscript?(input: { round: number; result: any; request: any }): void | Promise<void>;
  agentLoopRuntime: any;
  sessionClearCoordinator: any;
  createLLMSession(occurredAt: string): number;
  loadActiveTalkLLMSessionTranscript(): any;
  updateActiveTalkLLMSessionTranscript(session: any): void;
  rewriteActiveTalkLLMSessionFromRuntime(sessionId: number): void;
  conversationStore: Pick<AliceStore, "upsertInboundMessage">;
  agentState?: { setState(state: "calling" | "waiting", options?: { reason?: string }): unknown };
  appendLog(level: "info" | "warn" | "error", message: string): void;
}) {
  let talkRuntime: any;
  const talkAgentLoop = createTalkAgentLoopForSession({
    isActiveTalkLLMSession: input.isActiveTalkLLMSession,
    getCurrentTalkLLMSessionId: input.getCurrentTalkLLMSessionId,
    isTalkSessionOpen(sessionId) {
      return talkRuntime.store.getSession(sessionId)?.status === "open";
    },
    pendingVoiceOutputCharCount(sessionId) {
      return talkRuntime.store.pendingVoiceOutputCharCount(sessionId);
    },
    isForegroundPlaybackIdle(sessionId) {
      return talkRuntime.isForegroundPlaybackIdle(sessionId);
    },
    getTalkPromptProfile: input.getTalkPromptProfile,
    time: input.time,
    getPromptRenderer: input.getPromptRenderer,
    setLoopPrefixMessageCount(sessionId, count) {
      talkRuntime.setLoopPrefixMessageCount(sessionId, count);
    },
    buildNextLoopMessagePatch(sessionId, options) {
      return talkRuntime.buildNextLoopMessagePatch(sessionId, options);
    },
    loadActiveTalkLLMSessionTranscript: input.loadActiveTalkLLMSessionTranscript,
    updateActiveTalkLLMSessionTranscript: input.updateActiveTalkLLMSessionTranscript,
    prepareSessionContext: (contextInput: any) => input.agentLoopRuntime.prepareSessionContext(contextInput),
    visibleToolNames: input.visibleToolNames,
    toolPlugins: input.toolPlugins,
    getLLMConfig: input.getLLMConfig,
    sendRequest: input.sendRequest,
    appendAssistantDelta({ sessionId, outputId, delta }) {
      talkRuntime.appendAssistantDelta({ sessionId, outputId, delta });
    },
    finishAssistantOutput({ sessionId, outputId }) {
      talkRuntime.finishAssistantOutput({ sessionId, outputId });
    },
    log(level, message) {
      input.appendLog(level, message);
    }
  });

  talkRuntime = createTalkRuntime({
    store: createTalkStore(path.join("logs", "talk", "talk.sqlite")),
    time: input.time,
    sessionClearCoordinator: input.sessionClearCoordinator,
    // §7.2/§10: Talk 正常关闭进入 Main Agent clearing 占用(kind talk), 与 Chat/Memorize 清除互斥。
    acquireMainAgentClear: (clearInput) => input.agentLoopRuntime.beginClearSession(clearInput),
    // §7.2 clear() 回调步骤①: 先把活跃 Talk LLM transcript 从 runtime 重写至持久存储。
    rewriteActiveTalkLLMSessionFromRuntime(sessionId) {
      input.rewriteActiveTalkLLMSessionFromRuntime(sessionId);
    },
    // §7.2 clear() 回调步骤②: 对应 LLM session 标记 cleared 并清 current pointer。
    // 只能直接清除(不经 coordinator, 否则与正在执行的 talk clear 请求互相等待死锁)。
    clearActiveTalkLLMSession(sessionId) {
      if (input.isActiveTalkLLMSession(sessionId)) {
        input.agentLoopRuntime.clearCurrentLLMSessionDirect("talk_close");
      }
    },
    createLLMSession(sessionInput) {
      return input.createLLMSession(sessionInput.occurredAt);
    },
    prepareAgentLoop: (sessionId, options) => talkAgentLoop.prepareTalkAgentLoopForSession(sessionId, options),
    interruptAgentLoop(sessionId) {
      input.rewriteActiveTalkLLMSessionFromRuntime(sessionId);
      input.agentLoopRuntime.interrupt("talk_interrupt");
      talkAgentLoop.interruptTalkAgentLoop(sessionId);
    },
    onSessionOpened() {
      input.agentState?.setState("calling", { reason: "talk_session_opened" });
    },
    onSessionClosed(sessionId) {
      projectClosedTalkSessionToConversationHub(sessionId, talkRuntime.store, input.conversationStore, input.time);
      input.agentState?.setState("waiting", { reason: "talk_session_closed" });
    }
  });

  return { talkAgentLoop, talkRuntime };
}

export function projectClosedTalkSessionToConversationHub(
  sessionId: number,
  talkStore: ReturnType<typeof createTalkStore>,
  conversationStore: Pick<AliceStore, "upsertInboundMessage">,
  _time: { now(): { iso: string } }
): void {
  const session = talkStore.getSession(sessionId);
  if (!session) return;
  const entries = talkStore.listTranscriptEntries(sessionId);
  for (const entry of entries) {
    conversationStore.upsertInboundMessage({
      plugin: session.plugin || "webrtc_voice",
      externalMessageId: `voicecalltranscript:${session.sessionId}:${entry.entryId}`,
      conversationId: session.channelId || String(session.sessionId),
      senderId: session.userId,
      senderRole: "system",
      contentType: "voicecalltranscript",
      contentText: entry.contentText,
      contentJson: JSON.stringify({
        kind: "voicecalltranscript",
        talkSessionId: session.sessionId,
        entryId: entry.entryId,
        role: entry.role,
        sourceKind: entry.sourceKind,
        sourceId: entry.sourceId,
        sessionStartedAt: session.startedAt,
        sessionStartedAtUtc: session.startedAtUtc,
        sessionEndedAt: session.endedAt,
        sessionEndedAtUtc: session.endedAtUtc,
        durationMs: callDurationMs(session)
      }),
      createdAt: entry.occurredAt,
      createdAtUtc: entry.occurredAtUtc,
      lastEventAt: entry.occurredAt,
      lastEventAtUtc: entry.occurredAtUtc,
      coreProcessedAt: entry.occurredAt
    });
  }
}

function callDurationMs(session: TalkSession): number | undefined {
  const start = session.startedAtUtc ? Date.parse(session.startedAtUtc) : Date.parse(session.startedAt);
  const end = session.endedAtUtc ? Date.parse(session.endedAtUtc) : (session.endedAt ? Date.parse(session.endedAt) : NaN);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return end - start;
}
