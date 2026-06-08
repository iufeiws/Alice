import type { ActiveLLMSession } from "../domain/llm-session.js";
import { summarizeLLMSession } from "./llm-session-view.js";

export function createLLMSessionListRuntime(input: {
  archive: { readAll(): ActiveLLMSession[] };
  getActiveSession(): ActiveLLMSession | undefined;
}) {
  return {
    getClearedLLMSessions,
    getTalkLLMSessions
  };

  function getClearedLLMSessions(): unknown[] {
    const latestById = new Map<number, ActiveLLMSession>();
    for (const session of input.archive.readAll()) {
      if ((session.agentId ?? "chat") !== "chat") continue;
      latestById.set(session.id, session);
    }
    return [...latestById.values()]
      .filter((session) => Boolean(session.clearedAt))
      .sort((left, right) => String(left.startedAt || "").localeCompare(String(right.startedAt || "")))
      .slice(-50)
      .map(summarizeLLMSession);
  }

  function getTalkLLMSessions(): unknown[] {
    const latestById = new Map<number, ActiveLLMSession>();
    for (const session of input.archive.readAll()) {
      if (session.agentId !== "talk") continue;
      latestById.set(session.id, session);
    }
    const activeSession = input.getActiveSession();
    return [...latestById.values()]
      .filter((session) => session.id !== activeSession?.id)
      .sort((left, right) => String(left.startedAt || "").localeCompare(String(right.startedAt || "")))
      .slice(-50)
      .map(summarizeLLMSession);
  }
}
