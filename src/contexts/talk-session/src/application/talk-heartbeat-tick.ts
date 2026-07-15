import type { AgentHeartbeatTick } from "../../../agent-loop/src/runtime/agent-heartbeat-runtime.js";

export function createTalkHeartbeatTick(input: {
  canRun(): boolean;
  claimReadySession(): number | undefined;
  runSession(sessionId: number): Promise<boolean>;
  markReady(sessionId: number): void;
  appendLog(level: "info" | "error", message: string): void;
}): AgentHeartbeatTick {
  return async (options) => {
    if (options.force || !input.canRun()) return;
    const sessionId = input.claimReadySession();
    if (!sessionId) return;
    try {
      const started = await input.runSession(sessionId);
      if (!started) input.markReady(sessionId);
      return { processed: started ? 1 : 0 };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "llm_request_cancelled" || /abort/i.test(message)) {
        input.appendLog("info", `agent talk session cancelled: session=${sessionId} reason=${message}`);
      } else {
        input.appendLog("error", `agent talk session failed: session=${sessionId} error=${message}`);
        input.markReady(sessionId);
      }
    }
  };
}
