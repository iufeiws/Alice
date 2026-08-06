import type { ToolExecutionContext } from "../../agent-loop/src/contracts/agent-contracts.js";
import type { PiInvocationCompletion, PiModelConfig, PiWorkerRuntime, PiWorkerClient, PiWorkerHealth, PiToolDefinition } from "./contracts.js";

export function createPiWorkerRuntime(input: {
  worker: PiWorkerClient;
  /**
   * 宿主侧授权握手: 确保 capability 有效并按需向 worker 下发 relay 配置。
   * reason="call" 由懒授权检查触发(仅在不一致/过期时下发);
   * reason="wake"|"config" 由 refresh() 触发(强制下发, 轮换受 0-running 守护)。
   */
  refreshAuthorization?(input: { reason: "wake" | "config" | "call"; force?: boolean }): Promise<void>;
  prepareModel?(input: { presetName?: string }): Promise<PiModelConfig> | PiModelConfig;
  refreshToolRegistry?: () => void | Promise<void>;
  /** 授权有效期; 到期后下一次 subagent 调用前重新握手。 */
  authorizationTtlMs?: number;
  reconcileOnStart?: boolean;
  pollIntervalMs?: number;
  appendLog?(level: "info" | "warn" | "error", message: string): void;
  onInvocationCompleted?(completion: PiInvocationCompletion): Promise<void> | void;
}): PiWorkerRuntime {
  const authorizationTtlMs = input.authorizationTtlMs ?? 8 * 60 * 60 * 1000;
  let healthSnapshot: PiWorkerHealth | undefined;
  /** 本进程上次成功握手的时刻; 0 = 尚未握手, 视为已过期。 */
  let lastGrantedAt = 0;
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
        healthSnapshot = await ensureGranted();
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
    async refresh(reason) {
      await this.stop();
      let failure: unknown;
      try {
        await input.refreshAuthorization?.({ reason });
        lastGrantedAt = Date.now();
        healthSnapshot = await input.worker.health();
      } catch (error) {
        failure = error;
        healthSnapshot = undefined;
      }
      try {
        await input.refreshToolRegistry?.();
        await reconcileInvocations();
      } catch (error) {
        if (!failure) failure = error;
      }
      await this.start();
      if (failure) throw failure;
    },
    async health() {
      healthSnapshot = await input.worker.health();
      return healthSnapshot;
    },
    async previewPrompt(previewInput = {}) {
      const modelConfig = await resolveModelConfig(previewInput.presetName);
      healthSnapshot = await ensureGranted();
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
      healthSnapshot = await ensureGranted();
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
    async messagesSubAgent(sessionId, access, signal) {
      return input.worker.sessionMessages(sessionId, access, signal);
    },
    async sendSubAgent(sessionId, subInput) {
      const modelConfig = await resolveModelConfig(subInput.presetName);
      healthSnapshot = await ensureGranted();
      const invocation = await input.worker.sendInvocation(sessionId, {
        message: subInput.message,
        timeoutSeconds: subInput.timeoutSeconds,
        messageTarget: subInput.messageTarget,
        ...modelConfig,
        signal: subInput.signal
      });
      watch(sessionId);
      return invocation;
    },
    async statusSubAgent(sessionId, signal) {
      return input.worker.subAgentStatus(sessionId, signal);
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

  /**
   * 懒授权: subagent 调用前的单次握手。
   * worker 健康且授权未过期 → 直接放行; 否则触发宿主握手(不一致时更新容器内授权),
   * 然后以一次 health 确认结果。不重试 —— 失败由调用方重试整个调用。
   */
  async function ensureGranted(): Promise<PiWorkerHealth> {
    let health: PiWorkerHealth | undefined;
    try {
      health = await input.worker.health();
    } catch {
      health = undefined; // worker 未就绪: 进入握手路径
    }
    if (health?.ready && Date.now() - lastGrantedAt < authorizationTtlMs) return health;
    await input.refreshAuthorization?.({ reason: "call", force: !health?.ready });
    lastGrantedAt = Date.now();
    health = await input.worker.health();
    if (!health?.ready) throw new Error("pi_worker_relay_not_ready");
    return health;
  }

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
