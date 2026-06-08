import { createTalkAgentLoopForSession } from "../../../agent-loop/src/application/run-talk-loop.js";
import { createTalkStore } from "../adapters/sqlite-talk-session-store.js";
import { createTalkRuntime } from "../application/talk-session-runtime.js";

const path = await import("node:path");

export function createTalkRuntimeRuntime(input: {
  isActiveTalkLLMSession(sessionId: string): boolean;
  getActiveTalkLLMSessionId(): number | undefined;
  getTalkPromptProfile(): any;
  time: any;
  dailyShellStore: any;
  getAppearanceDescription(): string;
  memoryStore: any;
  diaryStore: any;
  visibleToolNames(profile: any): string[];
  toolPlugins: any[];
  getLLMConfig(): any;
  sendRequest(input: any): Promise<any>;
  createLLMSession(occurredAt: string): number;
  rewriteActiveTalkLLMSessionFromRuntime(sessionId: string): void;
  agentState?: { setState(state: "calling" | "waiting", options?: { reason?: string }): unknown };
  appendLog(level: "info" | "warn" | "error", message: string): void;
}) {
  let talkRuntime: any;
  const talkAgentLoop = createTalkAgentLoopForSession({
    isActiveTalkLLMSession: input.isActiveTalkLLMSession,
    getActiveTalkLLMSessionId: input.getActiveTalkLLMSessionId,
    isTalkSessionOpen(sessionId) {
      return talkRuntime.store.getSession(sessionId)?.status === "open";
    },
    pendingVoiceOutputCharCount(sessionId) {
      return talkRuntime.store.pendingVoiceOutputCharCount(sessionId);
    },
    getTalkPromptProfile: input.getTalkPromptProfile,
    time: input.time,
    dailyShellStore: input.dailyShellStore,
    getAppearanceDescription: input.getAppearanceDescription,
    memoryStore: input.memoryStore,
    diaryStore: input.diaryStore,
    buildNextLoopMessages(sessionId) {
      return talkRuntime.buildNextLoopMessages(sessionId);
    },
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
    onMaxContinuousRounds({ sessionId, rounds }) {
      talkRuntime.noteAgentLoopMaxContinuousRounds({ sessionId, rounds });
    },
    log(level, message) {
      input.appendLog(level, message);
    }
  });

  talkRuntime = createTalkRuntime({
    store: createTalkStore(path.join("data", "talk.sqlite")),
    time: input.time,
    createLLMSession(sessionInput) {
      return input.createLLMSession(sessionInput.occurredAt);
    },
    runAgentLoop: talkAgentLoop.runTalkAgentLoopForSession,
    interruptAgentLoop(sessionId) {
      input.rewriteActiveTalkLLMSessionFromRuntime(sessionId);
      talkAgentLoop.interruptTalkAgentLoop(sessionId);
    },
    onSessionOpened() {
      input.agentState?.setState("calling", { reason: "talk_session_opened" });
    },
    onSessionClosed() {
      input.agentState?.setState("waiting", { reason: "talk_session_closed" });
    }
  });

  return { talkAgentLoop, talkRuntime };
}
