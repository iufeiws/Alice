import { createTalkAgentLoopForSession } from "../../../../core/agent/src/talk-loop.js";
import { createTalkStore } from "../../../../packages/storage/src/talk-store.js";
import { createTalkRuntime } from "../talk-runtime.js";

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
  appendLog(level: "info" | "warn" | "error", message: string): void;
}) {
  let talkRuntime: any;
  const talkAgentLoop = createTalkAgentLoopForSession({
    isActiveTalkLLMSession: input.isActiveTalkLLMSession,
    getActiveTalkLLMSessionId: input.getActiveTalkLLMSessionId,
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
    }
  });

  return { talkAgentLoop, talkRuntime };
}
