export type AgentHeartbeatRuntime = {
  schedule(delayMs?: number): void;
  clear(): void;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  isScheduled(): boolean;
  run(options?: AgentHeartbeatRunOptions): Promise<number>;
  flush(): void;
};

export type AgentHeartbeatRunOptions = {
  force?: boolean;
  runManualSessionWhenIdle?: boolean;
};

export type AgentHeartbeatRunTaskDeps = {
  isIdleTransitionDue?(): boolean;
  canRunHeartbeat(): boolean;
  tickAgentState?(): void;
  onHeartbeatTick?(): void;
  hasPendingUserMessages(): boolean;
  buildRandomizedInitiatedBehaviorEvent?(): unknown;
  runGeneratedSession(event: unknown, label: string): Promise<boolean>;
  runManualSession?(): Promise<boolean>;
  setAgentWaiting?(reason: string): void;
  claimReadyTalkSession?(): string | undefined;
  runTalkSession?(sessionId: string): Promise<boolean>;
  markTalkSessionReady?(sessionId: string): void;
  getPendingSessionIds(): string[];
  isProcessingSession(sessionId: string): boolean;
  beginProcessingSession(sessionId: string): void;
  finishProcessingSession(sessionId: string): void;
  getPendingMessageCount(sessionId: string): number;
  shouldProcessPendingSession(sessionId: string): boolean;
  markSessionNotPending(sessionId: string): void;
  processPendingSession(sessionId: string): Promise<void>;
  getSleepCocoonWakeEvent?(): unknown;
  getSleepCocoonGoodnightEvent?(): unknown;
  appendLog(level: "info" | "warn" | "error", message: string): void;
};

export function createAgentHeartbeatRuntime(input: {
  getIntervalMs(): number;
  startPaused?: boolean;
  run?(options?: AgentHeartbeatRunOptions): Promise<number>;
  tasks?: AgentHeartbeatRunTaskDeps;
  onPausedChange?(paused: boolean): void;
  appendLog(level: "info" | "warn" | "error", message: string): void;
}): AgentHeartbeatRuntime {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let paused = input.startPaused === true;

  return {
    schedule(delayMs = input.getIntervalMs()) {
      scheduleTimer(delayMs);
    },
    clear() {
      if (!timer) return;
      clearTimeout(timer);
      timer = undefined;
    },
    pause() {
      paused = true;
      persistPaused();
      this.clear();
      input.appendLog("info", "agent heartbeat paused");
    },
    resume() {
      paused = false;
      persistPaused();
      input.appendLog("info", "agent heartbeat resumed");
      this.schedule(0);
    },
    isPaused() {
      return paused;
    },
    isScheduled() {
      return Boolean(timer);
    },
    run(options) {
      return run(options);
    },
    flush() {
      this.clear();
    }
  };

  function persistPaused(): void {
    try {
      input.onPausedChange?.(paused);
    } catch (error) {
      input.appendLog("warn", `agent heartbeat state persist failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function run(options: AgentHeartbeatRunOptions = {}): Promise<number> {
    try {
      if (input.run) return await input.run(options);
      if (!input.tasks) return 0;
      return await runHeartbeatTasks(input.tasks, options);
    } finally {
      if (options.force !== true) {
        scheduleTimer(input.getIntervalMs());
      }
    }
  }

  function scheduleTimer(delayMs: number): void {
    if (paused) return;
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void run().catch((error) => {
        input.appendLog("error", `agent heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, Math.max(0, delayMs));
    (timer as { unref?: () => void }).unref?.();
  }
}

async function runHeartbeatTasks(tasks: AgentHeartbeatRunTaskDeps, options: AgentHeartbeatRunOptions = {}): Promise<number> {
  const force = options.force ?? false;
  let processed = 0;
  const randomizedInitiatedEvent = !force
    && tasks.isIdleTransitionDue?.()
    && tasks.canRunHeartbeat()
    && !tasks.hasPendingUserMessages()
    ? tasks.buildRandomizedInitiatedBehaviorEvent?.()
    : undefined;
  if (randomizedInitiatedEvent) {
    const handled = await tasks.runGeneratedSession(randomizedInitiatedEvent, "randomized initiated behavior");
    if (handled) processed += 1;
    tasks.setAgentWaiting?.("randomized_initiated_behavior");
    return processed;
  }

  tasks.tickAgentState?.();
  if (!force && !tasks.canRunHeartbeat()) return 0;
  if (tasks.canRunHeartbeat()) tasks.onHeartbeatTick?.();

  const talkSessionId = !force && tasks.canRunHeartbeat() ? tasks.claimReadyTalkSession?.() : undefined;
  if (talkSessionId) {
    try {
      const started = await (tasks.runTalkSession?.(talkSessionId) ?? Promise.resolve(false));
      if (!started) tasks.markTalkSessionReady?.(talkSessionId);
      if (started) processed += 1;
    } catch (error) {
      if (isHeartbeatCancellationError(error)) {
        tasks.appendLog("info", `agent talk session cancelled: session=${talkSessionId} reason=${error instanceof Error ? error.message : String(error)}`);
      } else {
        tasks.appendLog("error", `agent talk session failed: session=${talkSessionId} error=${error instanceof Error ? error.message : String(error)}`);
        tasks.markTalkSessionReady?.(talkSessionId);
      }
    }
  }

  const sleepCocoonWakeEvent = !force && tasks.canRunHeartbeat()
    ? tasks.getSleepCocoonWakeEvent?.()
    : undefined;
  if (sleepCocoonWakeEvent) {
    const handled = await tasks.runGeneratedSession(sleepCocoonWakeEvent, "sleep cocoon wake");
    if (handled) processed += 1;
  }

  const sleepCocoonGoodnightEvent = !force && tasks.canRunHeartbeat() && !tasks.hasPendingUserMessages()
    ? tasks.getSleepCocoonGoodnightEvent?.()
    : undefined;
  if (sleepCocoonGoodnightEvent) {
    const handled = await tasks.runGeneratedSession(sleepCocoonGoodnightEvent, "sleep cocoon goodnight");
    if (handled) processed += 1;
  }

  for (const sessionId of tasks.getPendingSessionIds()) {
    if (tasks.isProcessingSession(sessionId)) continue;
    const pendingCount = tasks.getPendingMessageCount(sessionId);
    if (pendingCount === 0) {
      tasks.markSessionNotPending(sessionId);
      continue;
    }
    if (!force && !tasks.shouldProcessPendingSession(sessionId)) continue;

    tasks.beginProcessingSession(sessionId);
    try {
      await tasks.processPendingSession(sessionId);
      processed += 1;
      if (tasks.getPendingMessageCount(sessionId) === 0) {
        tasks.markSessionNotPending(sessionId);
      }
    } catch (error) {
      tasks.appendLog("error", `agent session failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      tasks.finishProcessingSession(sessionId);
    }
  }

  if (force && options.runManualSessionWhenIdle && processed === 0) {
    const handled = await (tasks.runManualSession?.() ?? Promise.resolve(false));
    if (handled) processed += 1;
  }

  return processed;
}

function isHeartbeatCancellationError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return message === "llm_request_cancelled" || /abort/i.test(message);
}
