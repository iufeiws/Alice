import { describeError } from "../../../../shared/errors/src/index.js";

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
  getIdleTransitionDelayMs?(): number | undefined;
  onIdleTimerTransition?(input: { delayMs: number }): Promise<unknown> | unknown;
  canRunHeartbeat(): boolean;
  retryFailedSessionBeforeStateSwitch?(): Promise<boolean>;
  tickAgentState?(): void;
  onHeartbeatTick?(): void;
  hasPendingUserMessages(): boolean;
  buildRandomizedInitiatedBehaviorEvent?(): unknown;
  runGeneratedSession(event: unknown, label: string): Promise<boolean>;
  runManualSession?(): Promise<boolean>;
  setAgentWaiting?(reason: string): void;
  claimReadyTalkSession?(): number | undefined;
  runTalkSession?(sessionId: number): Promise<boolean>;
  markTalkSessionReady?(sessionId: number): void;
  getPendingSessionIds(): string[];
  isProcessingSession(sessionId: string): boolean;
  beginProcessingSession(sessionId: string): void;
  finishProcessingSession(sessionId: string): void;
  getPendingMessageCount(sessionId: string): number;
  shouldProcessPendingSession(sessionId: string): boolean;
  markSessionNotPending(sessionId: string): void;
  processPendingSession(sessionId: string): Promise<void>;
  getSleepCocoonWakeEvent?(): unknown;
  beforeSleepCocoonWakeSession?(event: unknown): Promise<void> | void;
  getSleepCocoonGoodnightEvent?(): unknown;
  getCalendarReminderEvent?(): unknown;
  getTimedYieldEvent?(): unknown;
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
      input.appendLog("warn", `agent heartbeat state persist failed: ${describeError(error)}`);
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
        input.appendLog("error", `agent heartbeat failed: ${describeError(error)}`);
      });
    }, Math.max(0, delayMs));
    (timer as { unref?: () => void }).unref?.();
  }
}

async function runHeartbeatTasks(tasks: AgentHeartbeatRunTaskDeps, options: AgentHeartbeatRunOptions = {}): Promise<number> {
  const force = options.force ?? false;
  let processed = 0;
  // 问题 2: force 只绕过延迟/随机行为等策略, 不绕过 Main Agent 互斥门控——
  // clearing/running 占用期间 force run 不进入任何任务分支(含 idle 过渡检查与状态 tick)。
  if (force && !tasks.canRunHeartbeat()) return 0;
  // 恢复原语义(HEAD): idle 过渡 hook 仅在非 force 心跳执行, force 不执行。
  const idleTransitionDue = !force && tasks.isIdleTransitionDue?.() === true;
  let idleTransitionEvent: unknown;
  if (idleTransitionDue && tasks.canRunHeartbeat()) {
    try {
      idleTransitionEvent = await tasks.onIdleTimerTransition?.({ delayMs: tasks.getIdleTransitionDelayMs?.() ?? 0 });
    } catch (error) {
      tasks.appendLog("warn", `idle timer transition hook failed: ${describeError(error)}`);
    }
  }
  if (idleTransitionEvent && tasks.canRunHeartbeat()) {
    const handled = await tasks.runGeneratedSession(idleTransitionEvent, "idle timer transition");
    if (handled) processed += 1;
    tasks.setAgentWaiting?.("idle_timer_transition");
    return processed;
  }
  const randomizedInitiatedEvent = idleTransitionDue
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

  if (await tasks.retryFailedSessionBeforeStateSwitch?.()) return processed;
  tasks.tickAgentState?.();
  // 非 force 门控(恢复 HEAD 位置): 占用期间非 force 心跳仍先 tick 状态
  // (睡眠/away 期间的周期性心跳), 但不得进入任何任务分支。
  if (!force && !tasks.canRunHeartbeat()) return 0;
  if (tasks.canRunHeartbeat()) tasks.onHeartbeatTick?.();

  const timedYieldEvent = !force && tasks.canRunHeartbeat() && !tasks.hasPendingUserMessages()
    ? tasks.getTimedYieldEvent?.()
    : undefined;
  if (timedYieldEvent) {
    const handled = await tasks.runGeneratedSession(timedYieldEvent, "timed yield");
    if (handled) processed += 1;
    return processed;
  }

  const talkSessionId = !force && tasks.canRunHeartbeat() ? tasks.claimReadyTalkSession?.() : undefined;
  if (talkSessionId) {
    try {
      const started = await (tasks.runTalkSession?.(talkSessionId) ?? Promise.resolve(false));
      if (!started) tasks.markTalkSessionReady?.(talkSessionId);
      if (started) processed += 1;
    } catch (error) {
      if (isHeartbeatCancellationError(error)) {
        tasks.appendLog("info", `agent talk session cancelled: session=${talkSessionId} reason=${describeError(error)}`);
      } else {
        tasks.appendLog("error", `agent talk session failed: session=${talkSessionId} error=${describeError(error)}`);
        tasks.markTalkSessionReady?.(talkSessionId);
      }
    }
  }

  const sleepCocoonWakeEvent = !force && tasks.canRunHeartbeat()
    ? tasks.getSleepCocoonWakeEvent?.()
    : undefined;
  if (sleepCocoonWakeEvent) {
    if (isSleepCocoonWakeEvent(sleepCocoonWakeEvent)) await tasks.beforeSleepCocoonWakeSession?.(sleepCocoonWakeEvent);
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

  const calendarReminderEvent = !force && tasks.canRunHeartbeat() && !tasks.hasPendingUserMessages()
    ? tasks.getCalendarReminderEvent?.()
    : undefined;
  if (calendarReminderEvent) {
    const handled = await tasks.runGeneratedSession(calendarReminderEvent, "calendar reminder");
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
      tasks.appendLog("error", `agent session failed: ${describeError(error)}`);
    } finally {
      tasks.finishProcessingSession(sessionId);
    }
    // 恢复原语义(HEAD): 一次 heartbeat run 逐个处理全部 pending 会话(无 break)。
  }

  if (force && options.runManualSessionWhenIdle && processed === 0) {
    const handled = await (tasks.runManualSession?.() ?? Promise.resolve(false));
    if (handled) processed += 1;
  }

  return processed;
}

function isSleepCocoonWakeEvent(event: unknown): boolean {
  return Boolean(event && typeof event === "object"
    && "meta" in event
    && typeof event.meta === "object"
    && event.meta
    && "raw" in event.meta
    && typeof event.meta.raw === "object"
    && event.meta.raw
    && "agentInitiatedTriggerEvent" in event.meta.raw
    && event.meta.raw.agentInitiatedTriggerEvent === "sleep_cocoon.wake");
}

function isHeartbeatCancellationError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return message === "llm_request_cancelled" || /abort/i.test(message);
}
