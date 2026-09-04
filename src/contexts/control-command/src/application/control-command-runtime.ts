import type { AgentEvent } from "../../../agent-loop/src/contracts/agent-contracts.js";
import type { AgentLoopRuntime } from "../../../agent-loop/src/runtime/agent-loop-runtime.js";
import type { AgentStateController } from "../../../agent-loop/src/domain/agent-loop-state.js";

export type ControlCommandRuntime = {
  handle(event: AgentEvent): false | Promise<true>;
};

export type ControlCommandRuntimeDeps = {
  agentLoopRuntime: Pick<AgentLoopRuntime, "beginClearSession">;
  agentState?: Pick<AgentStateController, "getSnapshot" | "setState" | "waitForWake">;
  clearLLMSession(reason: "force_wake" | "force_clear"): void | Promise<void>;
  onForceWake?: () => void;
  appendLog(level: "info" | "warn" | "error", message: string): void;
};

type ControlCommand = "force_wake" | "force_clear";

export function createControlCommandRuntime(deps: ControlCommandRuntimeDeps): ControlCommandRuntime {
  return {
    handle(event) {
      const command = parseControlCommand(event);
      if (!command) return false;
      return executeCommand(command, event);
    }
  };

  async function executeCommand(command: ControlCommand, event: AgentEvent): Promise<true> {
    const sessionId = event.externalSession.sessionId;
    const wasSleeping = command === "force_wake" && deps.agentState?.getSnapshot().state === "sleeping";
    const acquisition = deps.agentLoopRuntime.beginClearSession({ kind: "chat", sessionId });
    if (!acquisition.acquired) {
      deps.appendLog("warn", `${commandLogName(command)} skipped: main agent busy ${sessionId}`);
      return true;
    }

    try {
      await deps.clearLLMSession(command);
    } catch (error) {
      deps.appendLog("error", `${commandLogName(command)} llm session clear failed: ${error instanceof Error ? error.message : String(error)}`);
      return true;
    } finally {
      acquisition.release();
    }

    if (command === "force_wake") {
      deps.agentState?.setState("waiting", { reason: "force_wake", clearSleepCocoon: true });
      const wakeReady = wasSleeping ? deps.agentState?.waitForWake?.() : undefined;
      void Promise.resolve(wakeReady).then(
        () => deps.onForceWake?.(),
        (error) => deps.appendLog("error", `sandbox restart on force wake failed: ${error instanceof Error ? error.message : String(error)}`)
      );
    }

    deps.appendLog("info", `${commandLogName(command)} command handled: ${sessionId}`);
    return true;
  }
}

function parseControlCommand(event: AgentEvent): ControlCommand | undefined {
  if (event.payload.kind !== "text") return undefined;
  const text = event.payload.text.trim();
  if (text === "/force_wake") return "force_wake";
  if (text === "/force_clear") return "force_clear";
  return undefined;
}

function commandLogName(command: ControlCommand): string {
  return command.replaceAll("_", " ");
}
