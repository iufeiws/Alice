import type { ActiveLLMSession } from "./llm-session-types.js";
import { createLLMSessionArchive } from "./llm-session-archive.js";
import { createActiveLLMSessionRuntime } from "./active-llm-session-runtime.js";

export function createApiSessionRuntime(input: {
  config: any;
  time: any;
  getSession(): ActiveLLMSession | undefined;
  setSession(session: ActiveLLMSession | undefined): void;
  getConversationStartIndex(sessionId: string): number | undefined;
  buildTalkRuntimeMessages(sessionId: string): any;
  appendLog(level: "info" | "warn" | "error", message: string): void;
}) {
  const llmSessionArchive = createLLMSessionArchive({
    memoryRoot: input.config.memoryFiles.root,
    time: input.time,
    appendLog: input.appendLog
  });
  const activeLLMSessionRuntime = createActiveLLMSessionRuntime({
    time: input.time,
    archive: llmSessionArchive,
    getSession: input.getSession,
    setSession: input.setSession,
    getConversationStartIndex: input.getConversationStartIndex,
    buildTalkRuntimeMessages: input.buildTalkRuntimeMessages,
    appendLog: input.appendLog
  });

  function restoreActiveLLMSession(): ActiveLLMSession | undefined {
    const session = activeLLMSessionRuntime.restorePersistedActiveLLMSession();
    if (session) input.appendLog("info", `llm active session restored: session=${session.id} file=${session.archiveFilePath ?? ""} requests=${session.requestIds.length}`);
    return session;
  }

  return {
    llmSessionArchive,
    activeLLMSessionRuntime,
    restoreActiveLLMSession
  };
}
