import { createCurrentTimeProvider, type CurrentTimeProvider } from "../../time/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

export type AgentBehaviorState =
  | "idle"
  | "waiting"
  | "away"
  | "curious"
  | "working"
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
};

export type AgentStateStore = {
  read(): string | undefined;
  write(content: string): void;
};

export type AgentStateController = {
  start(): void;
  stop(): void;
  getSnapshot(): AgentStateSnapshot;
  setState(state: AgentBehaviorState, options?: { reason?: string; durationMs?: number }): AgentStateSnapshot;
  setIntimacy(value: number): AgentStateSnapshot;
  tick(): AgentStateSnapshot;
  noteInboundMessage(): AgentStateSnapshot;
  noteWorkStarted(options?: { serious?: boolean }): AgentStateSnapshot;
  noteWorkFinished(): AgentStateSnapshot;
  getInboundDelayMs(): number;
  canReplyToInbound(): boolean;
  canRunHeartbeat(): boolean;
  onChange(listener: (snapshot: AgentStateSnapshot) => void): () => void;
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
  const listeners = new Set<(snapshot: AgentStateSnapshot) => void>();

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
    snapshot = normalizeSnapshot(next, time, random, false);
    persist();
    emitChange();
    return clone(snapshot);
  }

  function transition(
    state: AgentBehaviorState,
    opts: { reason?: string; durationMs?: number; previousState?: AgentBehaviorState } = {}
  ): AgentStateSnapshot {
    const updatedAt = currentIso();
    const next: AgentStateSnapshot = {
      state,
      intimacy: snapshot.intimacy,
      updatedAt,
      lastInboundAt: snapshot.lastInboundAt,
      previousState: opts.previousState,
      reason: opts.reason,
      responseDelayMs: responseDelayFor(state, random)
    };

    if (state === "idle") {
      next.nextTransitionAt = addMsIso(opts.durationMs ?? randomRange(2 * MINUTE, 15 * MINUTE, random));
    } else if (state === "waiting" || state === "curious" || state === "going_to_sleep" || state === "test") {
      next.nextTransitionAt = addMsIso(opts.durationMs ?? ACTIVE_TIMEOUT_MS);
    } else if (state === "away") {
      next.nextTransitionAt = addMsIso(opts.durationMs ?? randomRange(5 * MINUTE, 30 * MINUTE, random));
    } else if (state === "sleeping") {
      next.nextTransitionAt = addMsIso(opts.durationMs ?? randomRange(6 * HOUR, 10 * HOUR, random));
    }

    return commit(next);
  }

  function addMs(ms: number): Date {
    return new Date(now().getTime() + Math.max(0, ms));
  }

  function addMsIso(ms: number): string {
    return time.addMs(ms, now()).iso;
  }

  function advanceDueTransitions(): AgentStateSnapshot {
    if (!isDeadlineDue(snapshot, now())) {
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
      return transition(state, opts);
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
      const next = {
        ...snapshot,
        lastInboundAt: inboundAt,
        updatedAt: inboundAt
      };
      if (snapshot.state === "waiting" || snapshot.state === "curious" || snapshot.state === "going_to_sleep") {
        next.nextTransitionAt = addMsIso(ACTIVE_TIMEOUT_MS);
      }
      return commit(next);
    },
    noteWorkStarted(opts = {}) {
      const baseline = opts.serious ? "serious" : snapshot.state === "serious" ? "serious" : snapshot.state === "test" ? "test" : "waiting";
      return transition("working", { reason: opts.serious ? "serious_task" : "task", previousState: baseline });
    },
    noteWorkFinished() {
      const baseline = snapshot.previousState === "serious" ? "serious" : snapshot.previousState === "test" ? "test" : "waiting";
      return transition(baseline, { reason: "task_finished" });
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
    }
  };

  function emitChange(): void {
    const current = clone(snapshot);
    for (const listener of listeners) listener(current);
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
  const state = recoverTransient && rawState === "working" ? (previousState === "serious" ? "serious" : "waiting") : rawState;
  return {
    state,
    intimacy: clampIntimacy(value.intimacy),
    updatedAt: validIso(value.updatedAt) ?? time.now().iso,
    lastInboundAt: validIso(value.lastInboundAt),
    nextTransitionAt: validIso(value.nextTransitionAt) ?? validIso(value.deadlineAt) ?? validIso(value.sleepUntil),
    previousState: state === rawState ? previousState : undefined,
    reason: typeof value.reason === "string" ? value.reason : undefined,
    responseDelayMs: positiveNumber(value.responseDelayMs) ?? responseDelayFor(state, random)
  };
}

function defaultSnapshot(time: CurrentTimeProvider, random: () => number): AgentStateSnapshot {
  const current = time.now();
  return {
    state: "waiting",
    intimacy: DEFAULT_INTIMACY,
    updatedAt: current.iso,
    nextTransitionAt: time.addMs(ACTIVE_TIMEOUT_MS, current.date).iso,
    responseDelayMs: responseDelayFor("waiting", random)
  };
}

function isAgentBehaviorState(value: unknown): value is AgentBehaviorState {
  return typeof value === "string" && [
    "idle",
    "waiting",
    "away",
    "curious",
    "working",
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

function getDeadlineMs(snapshot: AgentStateSnapshot, now: Date): number | undefined {
  const deadline = snapshot.nextTransitionAt;
  if (!deadline) return undefined;
  return new Date(deadline).getTime() - now.getTime();
}

function isDeadlineDue(snapshot: AgentStateSnapshot, now: Date): boolean {
  const delay = getDeadlineMs(snapshot, now);
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
  if (state === "curious") return randomRange(8 * SECOND, 12 * SECOND, random);
  return randomRange(8 * SECOND, 15 * SECOND, random);
}

function canReplyToInbound(state: AgentBehaviorState): boolean {
  return state !== "away" && state !== "sleeping" && state !== "working";
}

function canRunHeartbeat(state: AgentBehaviorState): boolean {
  return state !== "away" && state !== "sleeping" && state !== "working";
}
