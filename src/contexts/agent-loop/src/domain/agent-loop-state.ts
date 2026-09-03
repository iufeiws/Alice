import { createCurrentTimeProvider, parseZonedIso } from "../../../../platform/time/src/index.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

export type AgentBehaviorState =
  | "idle"
  | "waiting"
  | "calling"
  | "away"
  | "curious"
  | "going_to_sleep"
  | "sleeping"
  | "serious"
  | "test";

export type AgentStateSnapshot = {
  state: AgentBehaviorState;
  intimacy: number;
  updatedAt: string;
  lastInboundAt?: string;
  nextTransitionAt?: string;
  previousState?: AgentBehaviorState;
  reason?: string;
  responseDelayMs: number;
  sleepCocoonEnteredAt?: string;
  sleepCocoonEnteredAtUtc?: string;
  sleepDurationMs?: number;
  sleepCocoonAutoCheckedAt?: string;
};

export type AgentStateTransition = {
  previous: AgentStateSnapshot;
  current: AgentStateSnapshot;
};

export type AgentStateStore = {
  read(): string | undefined;
  write(content: string): void;
};

export type AgentStateController = {
  start(): void;
  stop(): void;
  activate(agentId: "chat"): AgentStateSnapshot;
  getSnapshot(): AgentStateSnapshot;
  setState(state: AgentBehaviorState, options?: { reason?: string; durationMs?: number; sleepDurationMs?: number; sleepCocoonEnteredAt?: string; sleepCocoonEnteredAtUtc?: string; resetSleepCocoonAuto?: boolean; clearSleepCocoon?: boolean }): AgentStateSnapshot;
  noteSleepCocoonAutoChecked(): AgentStateSnapshot;
  setIntimacy(value: number): AgentStateSnapshot;
  tick(): AgentStateSnapshot;
  noteInboundMessage(): AgentStateSnapshot;
  noteInboundProcessed(): AgentStateSnapshot;
  suspendInactivityTimer(): AgentStateSnapshot;
  restartInactivityTimer(): AgentStateSnapshot;
  acquireSubAgentHold(): AgentStateSnapshot;
  releaseSubAgentHold(): AgentStateSnapshot;
  getSubAgentHoldCount(): number;
  waitForWake?(): Promise<void>;
  getInboundDelayMs(): number;
  canReplyToInbound(): boolean;
  canRunHeartbeat(): boolean;
  onChange(listener: (snapshot: AgentStateSnapshot) => void): () => void;
  onTransition(listener: (transition: AgentStateTransition) => void): () => void;
};

export type AgentStateControllerOptions = {
  store: AgentStateStore;
  now?: () => Date;
  time?: CurrentTimeProvider;
  timeZone?: string;
  random?: () => number;
  onPersistError?: (error: unknown) => void;
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const DEFAULT_INTIMACY = 50;
const ACTIVE_TIMEOUT_MS = 5 * MINUTE;
const WAITING_INACTIVE_TIMEOUT_MS = 15 * MINUTE;

export function createJsonAgentStateStore(filePath: string): AgentStateStore {
  return {
    read() {
      return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : undefined;
    },
    write(content) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }
  };
}

export function createAgentStateController(options: AgentStateControllerOptions): AgentStateController {
  const time = options.time ?? createCurrentTimeProvider(options.timeZone ?? "UTC", options.now);
  const now = () => time.now().date;
  const random = options.random ?? Math.random;

  let snapshot = normalizeSnapshot(readPersisted(options.store), time, random, true);
  let subAgentHoldCount = 0;
  const listeners = new Set<(snapshot: AgentStateSnapshot) => void>();
  const transitionListeners = new Set<(transition: AgentStateTransition) => void>();

  function currentIso(): string {
    return time.now().iso;
  }

  function persist(): void {
    try {
      options.store.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    } catch (error) {
      options.onPersistError?.(error);
    }
  }

  function commit(next: AgentStateSnapshot): AgentStateSnapshot {
    const previous = clone(snapshot);
    snapshot = normalizeSnapshot(next, time, random, false);
    const current = clone(snapshot);
    persist();
    emitChange();
    if (previous.state !== current.state) emitTransition(previous, current);
    return clone(snapshot);
  }

  function transition(
    state: AgentBehaviorState,
    opts: { reason?: string; durationMs?: number; previousState?: AgentBehaviorState; sleepDurationMs?: number; sleepCocoonEnteredAt?: string; sleepCocoonEnteredAtUtc?: string; resetSleepCocoonAuto?: boolean; clearSleepCocoon?: boolean } = {}
  ): AgentStateSnapshot {
    const updatedAt = currentIso();
    const next: AgentStateSnapshot = {
      state,
      intimacy: snapshot.intimacy,
      updatedAt,
      lastInboundAt: snapshot.lastInboundAt,
      previousState: opts.previousState,
      reason: opts.reason,
      responseDelayMs: responseDelayFor(state, random),
      sleepCocoonEnteredAt: opts.clearSleepCocoon ? undefined : opts.sleepCocoonEnteredAt ?? snapshot.sleepCocoonEnteredAt,
      sleepCocoonEnteredAtUtc: opts.clearSleepCocoon ? undefined : opts.sleepCocoonEnteredAtUtc ?? snapshot.sleepCocoonEnteredAtUtc,
      sleepDurationMs: opts.clearSleepCocoon ? undefined : opts.sleepDurationMs ?? snapshot.sleepDurationMs,
      sleepCocoonAutoCheckedAt: opts.clearSleepCocoon || opts.resetSleepCocoonAuto ? undefined : snapshot.sleepCocoonAutoCheckedAt
    };

    if (state === "idle") {
      next.nextTransitionAt = addMsIso(opts.durationMs ?? randomRange(2 * MINUTE, 15 * MINUTE, random));
    } else if (state === "waiting") {
      next.nextTransitionAt = subAgentHoldCount > 0 ? undefined : addMsIso(opts.durationMs ?? WAITING_INACTIVE_TIMEOUT_MS);
    } else if (state === "curious" || state === "going_to_sleep" || state === "test") {
      next.nextTransitionAt = addMsIso(opts.durationMs ?? ACTIVE_TIMEOUT_MS);
    } else if (state === "away") {
      next.nextTransitionAt = addMsIso(opts.durationMs ?? randomRange(5 * MINUTE, 30 * MINUTE, random));
    } else if (state === "sleeping") {
      next.nextTransitionAt = addMsIso(opts.durationMs ?? next.sleepDurationMs ?? randomRange(6 * HOUR, 10 * HOUR, random));
    }

    return commit(next);
  }

  function addMsIso(ms: number): string {
    return time.addMs(ms, now()).iso;
  }

  function advanceDueTransitions(): AgentStateSnapshot {
    if (!isDeadlineDue(snapshot, now(), time.timeZone)) {
      return clone(snapshot);
    }

    if (snapshot.state === "idle") {
      const roll = random();
      const waitingProbability = 0.5 * snapshot.intimacy / 100;
      if (roll < waitingProbability) {
        return transition("waiting", { reason: "idle_timer" });
      } else if (roll < waitingProbability + 0.1) {
        return transition("away", { reason: "idle_timer" });
      }
      return transition("idle", { reason: "idle_timer" });
    }

    if (snapshot.state === "waiting") {
      return transition("idle", { reason: "inactive" });
    }

    if (snapshot.state === "calling") {
      return clone(snapshot);
    }

    if (snapshot.state === "away") {
      return transition("waiting", { reason: "returned" });
    }

    if (snapshot.state === "curious") {
      return transition("waiting", { reason: "inactive" });
    }

    if (snapshot.state === "going_to_sleep") {
      return transition("sleeping", { reason: "sleep_started" });
    }

    if (snapshot.state === "sleeping") {
      return transition("waiting", { reason: "woke" });
    }

    return clone(snapshot);
  }

  return {
    start() {
      persist();
    },
    stop() {},
    getSnapshot() {
      return clone(snapshot);
    },
    setState(state, opts = {}) {
      if (subAgentHoldCount > 0 && state !== "waiting") throw new Error("agent_state_waiting_locked");
      return transition(state, opts);
    },
    activate(agentId) {
      if (agentId !== "chat") throw new Error(`agent_activation_unsupported:${agentId}`);
      return transition("waiting", { reason: "chat_activated" });
    },
    noteSleepCocoonAutoChecked() {
      const checkedAt = currentIso();
      return commit({
        ...snapshot,
        updatedAt: checkedAt,
        sleepCocoonAutoCheckedAt: checkedAt
      });
    },
    setIntimacy(value) {
      return commit({
        ...snapshot,
        intimacy: clampIntimacy(value),
        updatedAt: currentIso()
      });
    },
    tick() {
      return advanceDueTransitions();
    },
    noteInboundMessage() {
      const inboundAt = currentIso();
      return commit({
        ...snapshot,
        lastInboundAt: inboundAt,
        updatedAt: inboundAt,
        nextTransitionAt: hasInactivityTimer(snapshot.state) ? undefined : snapshot.nextTransitionAt
      });
    },
    noteInboundProcessed() {
      if (snapshot.state === "idle" || snapshot.state === "curious") {
        return transition("waiting", { reason: "inbound_processed" });
      }
      return clone(snapshot);
    },
    suspendInactivityTimer() {
      if (!hasInactivityTimer(snapshot.state)) return clone(snapshot);
      return commit({
        ...snapshot,
        updatedAt: currentIso(),
        nextTransitionAt: undefined
      });
    },
    restartInactivityTimer() {
      if (subAgentHoldCount > 0) return clone(snapshot);
      const timeoutMs = inactivityTimeoutMs(snapshot.state);
      if (timeoutMs === undefined) return clone(snapshot);
      const restartedAt = currentIso();
      return commit({
        ...snapshot,
        updatedAt: restartedAt,
        nextTransitionAt: addMsIso(timeoutMs)
      });
    },
    acquireSubAgentHold() {
      subAgentHoldCount += 1;
      if (snapshot.state !== "waiting") return transition("waiting", { reason: "subagent_started" });
      return commit({ ...snapshot, updatedAt: currentIso(), nextTransitionAt: undefined });
    },
    releaseSubAgentHold() {
      if (subAgentHoldCount === 0) throw new Error("subagent_hold_not_acquired");
      subAgentHoldCount -= 1;
      if (subAgentHoldCount > 0) return clone(snapshot);
      return commit({ ...snapshot, updatedAt: currentIso(), nextTransitionAt: addMsIso(WAITING_INACTIVE_TIMEOUT_MS) });
    },
    getSubAgentHoldCount() {
      return subAgentHoldCount;
    },
    getInboundDelayMs() {
      return snapshot.responseDelayMs;
    },
    canReplyToInbound() {
      return canReplyToInbound(snapshot.state);
    },
    canRunHeartbeat() {
      return canRunHeartbeat(snapshot.state);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onTransition(listener) {
      transitionListeners.add(listener);
      return () => {
        transitionListeners.delete(listener);
      };
    }
  };

  function emitChange(): void {
    const current = clone(snapshot);
    for (const listener of listeners) listener(current);
  }

  function emitTransition(previous: AgentStateSnapshot, current: AgentStateSnapshot): void {
    const transition = { previous: clone(previous), current: clone(current) };
    for (const listener of transitionListeners) listener(transition);
  }
}

function readPersisted(store: AgentStateStore): unknown {
  const content = store.read();
  if (!content) return undefined;
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeSnapshot(raw: unknown, time: CurrentTimeProvider, random: () => number, recoverTransient: boolean): AgentStateSnapshot {
  if (!raw || typeof raw !== "object") return defaultSnapshot(time, random);
  const value = raw as Partial<AgentStateSnapshot> & { deadlineAt?: unknown; sleepUntil?: unknown };
  const rawState = isAgentBehaviorState(value.state) ? value.state : "waiting";
  const previousState = isAgentBehaviorState(value.previousState) ? value.previousState : undefined;
  const state = rawState;
  return {
    state,
    intimacy: clampIntimacy(value.intimacy),
    updatedAt: validIso(value.updatedAt) ?? time.now().iso,
    lastInboundAt: validIso(value.lastInboundAt),
    nextTransitionAt: validIso(value.nextTransitionAt) ?? validIso(value.deadlineAt) ?? validIso(value.sleepUntil),
    previousState,
    reason: typeof value.reason === "string" ? value.reason : undefined,
    responseDelayMs: positiveNumber(value.responseDelayMs) ?? responseDelayFor(state, random),
    sleepCocoonEnteredAt: validIso(value.sleepCocoonEnteredAt),
    sleepCocoonEnteredAtUtc: validIso(value.sleepCocoonEnteredAtUtc),
    sleepDurationMs: positiveNumber(value.sleepDurationMs),
    sleepCocoonAutoCheckedAt: validIso(value.sleepCocoonAutoCheckedAt)
  };
}

function defaultSnapshot(time: CurrentTimeProvider, random: () => number): AgentStateSnapshot {
  const current = time.now();
  return {
    state: "waiting",
    intimacy: DEFAULT_INTIMACY,
    updatedAt: current.iso,
    nextTransitionAt: time.addMs(WAITING_INACTIVE_TIMEOUT_MS, current.date).iso,
    responseDelayMs: responseDelayFor("waiting", random)
  };
}

function isAgentBehaviorState(value: unknown): value is AgentBehaviorState {
  return typeof value === "string" && [
    "idle",
    "waiting",
    "calling",
    "away",
    "curious",
    "going_to_sleep",
    "sleeping",
    "serious",
    "test"
  ].includes(value);
}

function clampIntimacy(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_INTIMACY;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function validIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return Number.isNaN(new Date(value).getTime()) ? undefined : value;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function getDeadlineMs(snapshot: AgentStateSnapshot, now: Date, timeZone: string): number | undefined {
  const deadline = snapshot.nextTransitionAt;
  if (!deadline) return undefined;
  return parseZonedIso(deadline, timeZone).getTime() - now.getTime();
}

function isDeadlineDue(snapshot: AgentStateSnapshot, now: Date, timeZone: string): boolean {
  const delay = getDeadlineMs(snapshot, now, timeZone);
  return delay !== undefined && delay <= 0;
}

function randomRange(min: number, max: number, random: () => number): number {
  return Math.round(min + (max - min) * random());
}

function clone(snapshot: AgentStateSnapshot): AgentStateSnapshot {
  return { ...snapshot };
}

function responseDelayFor(state: AgentBehaviorState, random: () => number): number {
  if (state === "idle") return randomRange(20 * SECOND, 120 * SECOND, random);
  if (state === "away") return randomRange(5 * MINUTE, 30 * MINUTE, random);
  if (state === "test") return 8 * SECOND;
  if (state === "calling") return 0;
  if (state === "curious") return randomRange(8 * SECOND, 12 * SECOND, random);
  return randomRange(8 * SECOND, 15 * SECOND, random);
}

function canReplyToInbound(state: AgentBehaviorState): boolean {
  return state !== "away" && state !== "sleeping";
}

function canRunHeartbeat(state: AgentBehaviorState): boolean {
  return state !== "away" && state !== "sleeping";
}

function hasInactivityTimer(state: AgentBehaviorState): boolean {
  return inactivityTimeoutMs(state) !== undefined;
}

function inactivityTimeoutMs(state: AgentBehaviorState): number | undefined {
  if (state === "waiting") return WAITING_INACTIVE_TIMEOUT_MS;
  if (state === "idle" || state === "curious" || state === "going_to_sleep") return ACTIVE_TIMEOUT_MS;
  return undefined;
}
