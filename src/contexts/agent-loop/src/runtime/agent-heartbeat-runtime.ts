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
  isMainAgentBusy?(): boolean;
  canRunHeartbeat(): boolean;
  notePendingInboundMessage?(): void;
  insertPendingBatchIntoActiveChat?(): boolean;
  startFailedSessionRetryBeforeStateSwitch?(): boolean;
  tickAgentState?(): void;
  onHeartbeatTick?(): void;
  hasPendingUserMessages(): boolean;
  buildRandomizedInitiatedBehaviorEvent?(): unknown;
  startGeneratedSession(event: unknown, label: string, options?: { setWaitingReasonAfter?: string }): boolean;
  startManualSession?(): boolean;
  claimReadyTalkSession?(): number | undefined;
  startTalkSession?(sessionId: number): boolean;
  getPendingSessionIds(): string[];
  isProcessingSession(sessionId: string): boolean;
  getPendingMessageCount(sessionId: string): number;
  shouldProcessPendingSession(sessionId: string): boolean;
  startPendingSession(sessionId: string): boolean;
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
  if (runHeartbeatPrelude(tasks)) return 0;
  if (tasks.startFailedSessionRetryBeforeStateSwitch?.()) return 1;
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
  if (tasks.isMainAgentBusy?.()) return 0;
  if (idleTransitionEvent && tasks.canRunHeartbeat()) {
    if (tasks.startGeneratedSession(idleTransitionEvent, "idle timer transition", { setWaitingReasonAfter: "idle_timer_transition" })) processed += 1;
    return processed;
  }
  const randomizedInitiatedEvent = idleTransitionDue
    && tasks.canRunHeartbeat()
    && !tasks.hasPendingUserMessages()
    ? tasks.buildRandomizedInitiatedBehaviorEvent?.()
    : undefined;
  if (randomizedInitiatedEvent) {
    if (tasks.startGeneratedSession(randomizedInitiatedEvent, "randomized initiated behavior", { setWaitingReasonAfter: "randomized_initiated_behavior" })) processed += 1;
    return processed;
  }

  tasks.tickAgentState?.();
  if (!tasks.canRunHeartbeat()) return 0;
  if (tasks.canRunHeartbeat()) tasks.onHeartbeatTick?.();

  const timedYieldEvent = !force && tasks.canRunHeartbeat() && !tasks.hasPendingUserMessages()
    ? tasks.getTimedYieldEvent?.()
    : undefined;
  if (timedYieldEvent) {
    if (tasks.startGeneratedSession(timedYieldEvent, "timed yield")) processed += 1;
    return processed;
  }

  const talkSessionId = !force && tasks.canRunHeartbeat() ? tasks.claimReadyTalkSession?.() : undefined;
  if (talkSessionId) {
    if (tasks.startTalkSession?.(talkSessionId)) processed += 1;
    return processed;
  }

  const sleepCocoonWakeEvent = !force && tasks.canRunHeartbeat()
    ? tasks.getSleepCocoonWakeEvent?.()
    : undefined;
  if (sleepCocoonWakeEvent) {
    if (isSleepCocoonWakeEvent(sleepCocoonWakeEvent)) await tasks.beforeSleepCocoonWakeSession?.(sleepCocoonWakeEvent);
    if (tasks.startGeneratedSession(sleepCocoonWakeEvent, "sleep cocoon wake")) processed += 1;
    return processed;
  }

  const sleepCocoonGoodnightEvent = !force && tasks.canRunHeartbeat() && !tasks.hasPendingUserMessages()
    ? tasks.getSleepCocoonGoodnightEvent?.()
    : undefined;
  if (sleepCocoonGoodnightEvent) {
    if (tasks.startGeneratedSession(sleepCocoonGoodnightEvent, "sleep cocoon goodnight")) processed += 1;
    return processed;
  }

  const calendarReminderEvent = !force && tasks.canRunHeartbeat() && !tasks.hasPendingUserMessages()
    ? tasks.getCalendarReminderEvent?.()
    : undefined;
  if (calendarReminderEvent) {
    if (tasks.startGeneratedSession(calendarReminderEvent, "calendar reminder")) processed += 1;
    return processed;
  }

  for (const sessionId of tasks.getPendingSessionIds()) {
    if (tasks.isProcessingSession(sessionId)) continue;
    const pendingCount = tasks.getPendingMessageCount(sessionId);
    if (pendingCount === 0) continue;
    if (!force && !tasks.shouldProcessPendingSession(sessionId)) continue;

    if (tasks.startPendingSession(sessionId)) processed += 1;
    return processed;
  }

  if (force && options.runManualSessionWhenIdle && processed === 0) {
    if (tasks.startManualSession?.()) processed += 1;
  }

  return processed;
}

function runHeartbeatPrelude(tasks: AgentHeartbeatRunTaskDeps): boolean {
  if (!tasks.canRunHeartbeat()) {
    tasks.tickAgentState?.();
    if (!tasks.canRunHeartbeat()) return true;
  }
  tasks.notePendingInboundMessage?.();
  if (tasks.insertPendingBatchIntoActiveChat?.()) return true;
  if (tasks.isMainAgentBusy?.()) return true;
  return false;
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
