import { createId } from "../../../shared/uuid/src/index.js";
import type { ToolExecutionContext } from "../../agent-loop/src/contracts/agent-contracts.js";
import type { PiSession, PiSandboxRuntime, PiSessionStatus, PiWorkerClient, PiWorkerHealth, PiToolDefinition } from "./contracts.js";

const terminalStatuses = new Set<PiSessionStatus>(["completed", "failed", "timed_out", "aborted", "interrupted"]);

export function createPiSandboxRuntime(input: {
  worker: PiWorkerClient;
  ensureWorker?(): Promise<void>;
  prepareSession?(input: { sessionId?: string; task: string; presetName?: string }): Promise<{ model?: string; temperature?: number; maxTokens?: number; extraParams?: Record<string, unknown>; supportsImage?: boolean; reasoning?: boolean } | void> | { model?: string; temperature?: number; maxTokens?: number; extraParams?: Record<string, unknown>; supportsImage?: boolean; reasoning?: boolean } | void;
  preparePreviewSession?(input: { sessionId: string; presetName?: string }): Promise<{ model?: string; temperature?: number; maxTokens?: number; extraParams?: Record<string, unknown>; supportsImage?: boolean; reasoning?: boolean } | void> | { model?: string; temperature?: number; maxTokens?: number; extraParams?: Record<string, unknown>; supportsImage?: boolean; reasoning?: boolean } | void;
  restartWorker?: (reason: "mount_changed" | "admin" | "wake" | "config") => Promise<void>;
  startupTimeoutMs?: number;
  reconcileOnStart?: boolean;
  pollIntervalMs?: number;
  appendLog?(level: "info" | "warn" | "error", message: string): void;
  onTerminal?(session: PiSession): Promise<void> | void;
}): PiSandboxRuntime {
  let healthSnapshot: PiWorkerHealth | undefined;
  const terminalListeners = new Set<(session: PiSession) => Promise<void> | void>();
  const deliveringTerminalSessions = new Set<string>();
  if (input.onTerminal) terminalListeners.add(input.onTerminal);
  const watchers = new Map<string, ReturnType<typeof setTimeout>>();
  let acceptingWatches = false;

  return {
    async start() {
      acceptingWatches = true;
      await input.ensureWorker?.();
      healthSnapshot = await waitForReadyHealth();
      if (input.reconcileOnStart !== false) await reconcileInterrupted();
      const sessions = await input.worker.listSessions();
      for (const session of sessions) {
        if (session.status === "queued" || session.status === "running") watch(session.sessionId);
        else if (terminalStatuses.has(session.status) && !session.completionDelivered) await notifyTerminal(session);
      }
    },
    async stop() {
      acceptingWatches = false;
      for (const timer of watchers.values()) clearTimeout(timer);
      watchers.clear();
    },
    async restart(reason) {
      await this.stop();
      await input.ensureWorker?.();
      await input.restartWorker?.(reason);
      healthSnapshot = await waitForReadyHealth();
      await reconcileInterrupted();
      await this.start();
    },
    async health() {
      healthSnapshot = await input.worker.health();
      return healthSnapshot;
    },
    async previewPrompt(previewInput = {}) {
      const sessionId = createId("pi_preview");
      const modelConfig = await input.preparePreviewSession?.({ sessionId, presetName: previewInput.presetName });
      return input.worker.previewSession({ ...modelConfig, sessionId, signal: previewInput.signal });
    },
    toolDefinitions() {
      return healthSnapshot?.toolDefinitions ?? [];
    },
    async executeTool(toolInput) {
      const signal = toolInput.context?.signal;
      if (signal?.aborted) throw new Error("pi_tool_cancelled");
      if (!healthSnapshot) await this.health();
      return input.worker.executeTool({ ...toolInput, signal });
    },
    async startSubAgent(sessionInput) {
      const session = await input.worker.createSession(sessionInput);
      const modelConfig = await input.prepareSession?.({ sessionId: session.sessionId, task: sessionInput.task, presetName: sessionInput.presetName });
      const started = await input.worker.startSession(session.sessionId, { ...modelConfig, signal: sessionInput.signal });
      watch(session.sessionId);
      return started;
    },
    async statusSubAgent(sessionId, cursor, signal) {
      const session = await input.worker.getSession(sessionId, signal);
      const events = await input.worker.listSessionEvents(sessionId, cursor, signal);
      return { ...session, events: events.events, nextCursor: events.nextCursor };
    },
    async cancelSubAgent(sessionId, signal) {
      const session = await input.worker.cancelSession(sessionId, signal);
      if (terminalStatuses.has(session.status)) await notifyTerminal(session);
      return session;
    },
    reconcileInterrupted,
    onTerminal(listener) {
      terminalListeners.add(listener);
      return () => terminalListeners.delete(listener);
    }
  };

  async function reconcileInterrupted(signal?: AbortSignal): Promise<PiSession[]> {
    const sessions = await input.worker.listSessions(signal);
    const interrupted: PiSession[] = [];
    for (const session of sessions) {
      if (session.status !== "queued" && session.status !== "running") continue;
      const next = await input.worker.markInterrupted(session.sessionId, signal);
      interrupted.push(next);
      await notifyTerminal(next);
    }
    return interrupted;
  }

  async function waitForReadyHealth(): Promise<PiWorkerHealth> {
    const deadline = Date.now() + (input.startupTimeoutMs ?? 60_000);
    let lastError: unknown;
    while (Date.now() <= deadline) {
      try {
        const health = await input.worker.health();
        if (health.ready && health.relayReachable) return health;
        lastError = new Error("pi_worker_not_ready");
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw lastError instanceof Error ? lastError : new Error("pi_worker_startup_timeout");
  }

  function watch(sessionId: string): void {
    if (!acceptingWatches || watchers.has(sessionId)) return;
    const poll = async () => {
      watchers.delete(sessionId);
      try {
        const session = await input.worker.getSession(sessionId);
        if (terminalStatuses.has(session.status)) {
          await notifyTerminal(session);
          return;
        }
        if (acceptingWatches) watchers.set(sessionId, setTimeout(() => void poll(), input.pollIntervalMs ?? 500));
      } catch (error) {
        input.appendLog?.("warn", `pi session watch failed: session=${sessionId} error=${error instanceof Error ? error.message : String(error)}`);
        if (acceptingWatches) watchers.set(sessionId, setTimeout(() => void poll(), input.pollIntervalMs ?? 500));
      }
    };
    watchers.set(sessionId, setTimeout(() => void poll(), 0));
  }

  async function notifyTerminal(session: PiSession): Promise<void> {
    if (session.completionDelivered || deliveringTerminalSessions.has(session.sessionId)) return;
    deliveringTerminalSessions.add(session.sessionId);
    try {
      for (const listener of terminalListeners) await listener(session);
      await input.worker.markCompletionDelivered(session.sessionId);
    } finally {
      deliveringTerminalSessions.delete(session.sessionId);
    }
  }
}
