import type { ToolExecutionContext } from "../../agent-loop/src/contracts/agent-contracts.js";
import type { PiInvocationCompletion, PiModelConfig, PiWorkerRuntime, PiWorkerClient, PiWorkerHealth, PiToolDefinition } from "./contracts.js";

export function createPiWorkerRuntime(input: {
  worker: PiWorkerClient;
  /**
   * 宿主侧授权握手: 确保 capability 有效并按需向 worker 下发 relay 配置。
   * 由 ensureGranted/wakeIfNeeded 触发; workerHealth 携带 worker 上报的凭证指纹,
   * 宿主据此判断是否需重新下发(失效凭证 → 重新注册)。
   */
  refreshAuthorization?(input: { reason: "wake" | "config" | "call"; force?: boolean; workerHealth?: PiWorkerHealth }): Promise<void>;
  prepareModel?(input: { presetName?: string }): Promise<PiModelConfig> | PiModelConfig;
  refreshToolRegistry?: () => void | Promise<void>;
  pollIntervalMs?: number;
  /** 调用路径上"确保 ready"的有界重试预算与间隔。 */
  handshakeRetryTimeoutMs?: number;
  handshakeRetryIntervalMs?: number;
  /** 后台唤起(wakeIfNeeded)的最小间隔。 */
  wakeIntervalMs?: number;
  appendLog?(level: "info" | "warn" | "error", message: string): void;
  onInvocationCompleted?(completion: PiInvocationCompletion): Promise<void> | void;
}): PiWorkerRuntime {
  const handshakeRetryTimeoutMs = input.handshakeRetryTimeoutMs ?? 20_000;
  const handshakeRetryIntervalMs = input.handshakeRetryIntervalMs ?? 500;
  const wakeIntervalMs = input.wakeIntervalMs ?? 30_000;
  let healthSnapshot: PiWorkerHealth | undefined;
  /** 本进程上次成功握手的时刻; 0 = 尚未握手, 视为已过期。 */
  let lastGrantedAt = 0;
  let lastWakeAttemptAt = 0;
  let waking = false;
  const completionListeners = new Set<(completion: PiInvocationCompletion) => Promise<void> | void>();
  const deliveredInvocations = new Set<string>();
  const deliveringInvocations = new Map<string, Promise<void>>();
  if (input.onInvocationCompleted) completionListeners.add(input.onInvocationCompleted);
  const watchers = new Map<string, ReturnType<typeof setTimeout>>();
  let acceptingWatches = false;

  return {
    async start() {
      // 不再做启动期握手: worker 由 heartbeat 后台唤起 + 真实调用时的
      // ensureGranted 懒拉起, 启动不触碰容器。
      acceptingWatches = true;
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
      } catch (error) {
        if (!failure) failure = error;
      }
      await this.start();
      if (failure) {
        // pi worker 层级消化错误: 不向调用方(admin 主流程)抛出,
        // 授权会在下一次 subagent 调用前由 ensureGranted 懒握手重试。
        input.appendLog?.("warn", `pi worker refresh failed (reason=${reason}): ${failure instanceof Error ? failure.message : String(failure)}`);
      }
    },
    async wakeIfNeeded() {
      const now = Date.now();
      if (now - lastWakeAttemptAt < wakeIntervalMs) return;
      lastWakeAttemptAt = now;
      if (waking) return;
      waking = true;
      try {
        let health: PiWorkerHealth | undefined;
        try {
          health = await input.worker.health();
        } catch {
          health = undefined;
        }
        // 单次尝试: 已授权且凭证一致时宿主直接快路径返回; 失败留到下一个 heartbeat。
        await handshakeOnce({ reason: "wake", force: !health?.ready, workerHealth: health });
      } catch (error) {
        input.appendLog?.("warn", `pi worker wake failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        waking = false;
      }
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
      healthSnapshot = await ensureGranted();
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
    async messagesSubAgent(nickname, access, signal) {
      return input.worker.sessionMessages(nickname, access, signal);
    },
    async sendSubAgent(nickname, subInput) {
      const modelConfig = await resolveModelConfig(subInput.presetName);
      healthSnapshot = await ensureGranted();
      const invocation = await input.worker.sendInvocation(nickname, {
        message: subInput.message,
        timeoutSeconds: subInput.timeoutSeconds,
        messageTarget: subInput.messageTarget,
        ...modelConfig,
        signal: subInput.signal
      });
      watch(invocation.sessionId);
      return invocation;
    },
    async statusSubAgent(nickname, signal) {
      return input.worker.subAgentStatus(nickname, signal);
    },
    async resultSubAgent(nickname, signal) {
      return input.worker.resultSession(nickname, signal);
    },
    async waitSubAgent(nickname, timeoutSeconds, signal) {
      return input.worker.waitSession(nickname, timeoutSeconds, signal);
    },
    async cancelSubAgent(nickname, signal) {
      return input.worker.cancelSession(nickname, signal);
    },
    async forkSubAgent(nickname, entryId, signal) {
      return input.worker.forkSession(nickname, entryId, signal);
    },
    onInvocationCompleted(listener) {
      completionListeners.add(listener);
      return () => completionListeners.delete(listener);
    }
  };

  /**
   * 单次握手: 向宿主发起授权握手(由宿主根据 worker 凭证指纹/授权有效期决定是否
   * 重新下发), 然后以一次 health 确认。失败由调用方决定是否重试。
   */
  async function handshakeOnce(handshakeInput: { reason: "wake" | "config" | "call"; force: boolean; workerHealth?: PiWorkerHealth }): Promise<PiWorkerHealth> {
    await input.refreshAuthorization?.({ ...handshakeInput });
    lastGrantedAt = Date.now();
    const health = await input.worker.health();
    if (!health?.ready) throw new Error("pi_worker_relay_not_ready");
    return health;
  }

  /**
   * 调用前确保 worker 已唤起且就绪: 总是向宿主发起授权握手, 然后以一次 health 确认。
   * 容器刚拉起时 worker 需 ~1s 才监听, 因此做有界重试(默认 20s/500ms)。
   */
  async function ensureGranted(): Promise<PiWorkerHealth> {
    const deadline = Date.now() + handshakeRetryTimeoutMs;
    let lastError: unknown;
    for (;;) {
      let health: PiWorkerHealth | undefined;
      try {
        health = await input.worker.health();
      } catch {
        health = undefined; // worker 未就绪: 进入握手路径
      }
      try {
        return await handshakeOnce({ reason: "call", force: !health?.ready, workerHealth: health });
      } catch (error) {
        lastError = error;
        if (Date.now() >= deadline) throw lastError;
        await new Promise((resolve) => setTimeout(resolve, handshakeRetryIntervalMs));
      }
    }
  }

  async function resolveModelConfig(presetName?: string): Promise<PiModelConfig> {
    const modelConfig = await input.prepareModel?.({ presetName });
    if (!modelConfig) throw new Error("pi_llm_preset_not_found");
    return modelConfig;
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
        const snapshot = await input.worker.sessionStatusBySessionId(sessionId);
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
