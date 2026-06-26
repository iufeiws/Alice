import type { LLMSessionRecord } from "../domain/llm-session.js";
import { createLLMSessionArchive } from "./archive-llm-session.js";
import { createLLMSessionRuntime } from "./llm-session-runtime.js";

export function createApiSessionRuntime(input: {
  config: any;
  time: any;
  getConversationStartIndex(sessionId: number): number | undefined;
  buildTalkRuntimeMessages(sessionId: number): any;
  appendLog(level: "info" | "warn" | "error", message: string): void;
}) {
  const llmSessionArchive = createLLMSessionArchive({
    memoryRoot: input.config.memoryFiles.root,
    time: input.time,
    appendLog: input.appendLog
  });
  const llmSessionRuntime = createLLMSessionRuntime({
    time: input.time,
    archive: llmSessionArchive,
    getConversationStartIndex: input.getConversationStartIndex,
    buildTalkRuntimeMessages: input.buildTalkRuntimeMessages,
    appendLog: input.appendLog
  });

  function restoreCurrentLLMSession(): LLMSessionRecord | undefined {
    const session = llmSessionRuntime.restorePersistedCurrentLLMSession();
    if (session) input.appendLog("info", `llm current session restored: session=${session.id} file=${session.archiveFilePath ?? ""} requests=${session.requestIds.length}`);
    return session;
  }

  return {
    llmSessionArchive,
    llmSessionRuntime,
    restoreCurrentLLMSession
  };
}
