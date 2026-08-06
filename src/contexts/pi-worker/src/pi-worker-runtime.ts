import type { ToolExecutionContext } from "../../agent-loop/src/contracts/agent-contracts.js";
import type { PiInvocationCompletion, PiModelConfig, PiWorkerRuntime, PiWorkerClient, PiWorkerHealth, PiToolDefinition } from "./contracts.js";

export function createPiWorkerRuntime(input: {
  worker: PiWorkerClient;
  ensureWorker?(): Promise<void>;
  prepareModel?(input: { presetName?: string }): Promise<PiModelConfig> | PiModelConfig;
  restartWorker?: (reason: "mount_changed" | "admin" | "wake" | "config") => Promise<void>;
  refreshToolRegistry?: () => void | Promise<void>;
  startupTimeoutMs?: number;
  reconcileOnStart?: boolean;
  pollIntervalMs?: number;
  appendLog?(level: "info" | "warn" | "error", message: string): void;
  onInvocationCompleted?(completion: PiInvocationCompletion): Promise<void> | void;
}): PiWorkerRuntime {
  let healthSnapshot: PiWorkerHealth | undefined;
  const completionListeners = new Set<(completion: PiInvocationCompletion) => Promise<void> | void>();
  const deliveredInvocations = new Set<string>();
  const deliveringInvocations = new Map<string, Promise<void>>();
  if (input.onInvocationCompleted) completionListeners.add(input.onInvocationCompleted);
  const watchers = new Map<string, ReturnType<typeof setTimeout>>();
  let acceptingWatches = false;

  return {
    async start() {
      acceptingWatches = true;
      try {
        await input.ensureWorker?.();
        healthSnapshot = await waitForReadyHealth();
      } catch (error) {
        input.appendLog?.("warn", `pi worker not ready: ${error instanceof Error ? error.message : String(error)}`);
        healthSnapshot = undefined;
      }
      if (healthSnapshot && input.reconcileOnStart !== false) await reconcileInvocations();
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
      await input.refreshToolRegistry?.();
      await reconcileInvocations();
      await this.start();
    },
    async health() {
      healthSnapshot = await input.worker.health();
      return healthSnapshot;
    },
    async previewPrompt(previewInput = {}) {
      const modelConfig = await resolveModelConfig(previewInput.presetName);
      return input.worker.previewSession({ ...modelConfig, signal: previewInput.signal });
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
    async startSubAgent(subInput) {
      const modelConfig = await resolveModelConfig(subInput.presetName);
      const invocation = await input.worker.startInvocation({
        message: subInput.message,
        timeoutSeconds: subInput.timeoutSeconds,
        messageTarget: subInput.messageTarget,
        ...modelConfig,
        signal: subInput.signal
      });
      watch(invocation.sessionId);
      return invocation;
    },
    async listSubAgents(signal) {
      return input.worker.listSessions(signal);
    },
    async readSubAgent(sessionId, view, signal) {
      return input.worker.readSession(sessionId, view, signal);
    },
    async sendSubAgent(sessionId, subInput) {
      const modelConfig = await resolveModelConfig(subInput.presetName);
      const invocation = await input.worker.sendInvocation(sessionId, {
        message: subInput.message,
        mode: subInput.mode,
        timeoutSeconds: subInput.timeoutSeconds,
        messageTarget: subInput.messageTarget,
        ...modelConfig,
        signal: subInput.signal
      });
      watch(sessionId);
      return invocation;
    },
    async statusSubAgent(sessionId, signal) {
      return input.worker.sessionStatus(sessionId, signal);
    },
    async waitSubAgent(sessionId, timeoutSeconds, signal) {
      return input.worker.waitSession(sessionId, timeoutSeconds, signal);
    },
    async cancelSubAgent(sessionId, signal) {
      return input.worker.cancelSession(sessionId, signal);
    },
    async forkSubAgent(sessionId, entryId, signal) {
      return input.worker.forkSession(sessionId, entryId, signal);
    },
    reconcileInvocations,
    onInvocationCompleted(listener) {
      completionListeners.add(listener);
      return () => completionListeners.delete(listener);
    }
  };

  async function resolveModelConfig(presetName?: string): Promise<PiModelConfig> {
    const modelConfig = await input.prepareModel?.({ presetName });
    if (!modelConfig) throw new Error("pi_llm_preset_not_found");
    return modelConfig;
  }

  async function reconcileInvocations(signal?: AbortSignal): Promise<PiInvocationCompletion[]> {
    const completions = await input.worker.reconcileInvocations(signal);
    for (const completion of completions) {
      await deliverCompletion(completion);
    }
    return completions;
  }

  async function deliverCompletion(completion: PiInvocationCompletion): Promise<void> {
    const key = `${completion.sessionId}:${completion.invocationId}`;
    if (deliveredInvocations.has(key)) return;
    const inFlight = deliveringInvocations.get(key);
    if (inFlight) return inFlight;
    const delivery = (async () => {
      try {
        for (const listener of completionListeners) await listener(completion);
        // Only mark delivered after every listener succeeded, so a delivery
        // error leaves the completion retryable by the next reconciliation.
        deliveredInvocations.add(key);
      } finally {
        deliveringInvocations.delete(key);
      }
    })();
    deliveringInvocations.set(key, delivery);
    return delivery;
  }

  async function waitForReadyHealth(): Promise<PiWorkerHealth> {
    const deadline = Date.now() + (input.startupTimeoutMs ?? 60_000);
    let lastError: unknown;
    while (Date.now() <= deadline) {
      try {
        const health = await input.worker.health();
        // The worker answering is enough: relay reachability depends on the
        // host-side preset configuration, not on container state. Return the
        // snapshot either way so tools keep working and SubAgent fails with an
        // actionable preset error instead of a startup hang when no preset is
        // configured yet.
        return health;
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
        const snapshot = await input.worker.sessionStatus(sessionId);
        if (snapshot.terminalCompletions?.length) {
          for (const completion of snapshot.terminalCompletions) await deliverCompletion(completion);
        } else if (snapshot.lastInvocation) {
          await deliverCompletion(snapshot.lastInvocation);
        }
        if (!snapshot.idle && acceptingWatches) {
          watchers.set(sessionId, setTimeout(() => void poll(), input.pollIntervalMs ?? 500));
        }
      } catch (error) {
        input.appendLog?.("warn", `pi session watch failed: session=${sessionId} error=${error instanceof Error ? error.message : String(error)}`);
        if (acceptingWatches) watchers.set(sessionId, setTimeout(() => void poll(), input.pollIntervalMs ?? 500));
      }
    };
    watchers.set(sessionId, setTimeout(() => void poll(), 0));
  }
}
