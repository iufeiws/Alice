import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentStateRuntime } from "../../../src/contexts/agent-loop/src/runtime/agent-state-runtime.js";
import { createCurrentTimeProvider } from "../../../src/platform/time/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");
const os = await import("node:os");

test("waking from sleeping records the configured local and UTC wake time", () => {
  const root = makeTempDir("agent-state-runtime-wake-time");
  writePersistedState(root, "sleeping");
  const calls = createCalls();
  const agentState = createRuntime(root, calls);

  const snapshot = agentState.setState("waiting", { reason: "woke" });

  assert.equal(snapshot.state, "waiting");
  assert.equal(snapshot.reason, "woke");
  assert.deepEqual(calls.wakeBoundaries, [{
    occurredAt: "2026-05-26T08:00:00.000",
    occurredAtUtc: "2026-05-26T00:00:00.000Z",
    now: "2026-05-26T08:00:00.000",
    nowUtc: "2026-05-26T00:00:00.000Z"
  }]);
});

test("waking from sleeping rerolls the daily shell and sends it to on-body generation", () => {
  const root = makeTempDir("agent-state-runtime-wake-daily");
  writePersistedState(root, "sleeping");
  const calls = createCalls();
  const agentState = createRuntime(root, calls);

  agentState.setState("waiting", { reason: "woke" });

  assert.deepEqual(calls.rerolls, [{
    dateIso: "2026-05-26T00:00:00.000Z",
    timeZone: "Asia/Shanghai"
  }]);
  assert.deepEqual(calls.onBodyDailies, [dailyShell]);
});

test("waking from sleeping queues morning work", () => {
  const root = makeTempDir("agent-state-runtime-wake-morning");
  writePersistedState(root, "sleeping");
  const calls = createCalls();
  const agentState = createRuntime(root, calls);

  agentState.setState("waiting", { reason: "woke" });

  assert.equal(calls.morningEvents, 1);
});

test("waking waits for the sandbox restart before queuing morning work", async () => {
  const root = makeTempDir("agent-state-runtime-wake-restart");
  writePersistedState(root, "sleeping");
  const calls = createCalls();
  let resolveRestart!: () => void;
  const restart = new Promise<void>((resolve) => { resolveRestart = resolve; });
  const agentState = createRuntime(root, calls, () => restart);

  agentState.setState("waiting", { reason: "woke" });
  assert.equal(calls.morningEvents, 0);
  resolveRestart();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.morningEvents, 1);
});

test("entering sleeping records sleep time", () => {
  const root = makeTempDir("agent-state-runtime-sleep");
  const calls = createCalls();
  const agentState = createRuntime(root, calls);

  const snapshot = agentState.setState("sleeping", { reason: "sleep_started" });

  assert.equal(snapshot.state, "sleeping");
  assert.deepEqual(calls.sleepBoundaries, [{
    occurredAt: "2026-05-26T08:00:00.000",
    occurredAtUtc: "2026-05-26T00:00:00.000Z",
    source: "sleep",
    now: "2026-05-26T08:00:00.000",
    nowUtc: "2026-05-26T00:00:00.000Z"
  }]);
});

test("entering sleeping clears the LLM session", () => {
  const root = makeTempDir("agent-state-runtime-sleep-clear-session");
  const calls = createCalls();
  const agentState = createRuntime(root, calls);

  agentState.setState("sleeping", { reason: "sleep_started" });

  assert.equal(calls.clearedSessions, 1);
});

test("entering sleeping sends a sleep notice", () => {
  const root = makeTempDir("agent-state-runtime-sleep-notice");
  const calls = createCalls();
  const agentState = createRuntime(root, calls);

  agentState.setState("sleeping", { reason: "sleep_started" });

  assert.equal(calls.sleepNotices, 1);
});

test("entering sleeping triggers sleep memory induction", () => {
  const root = makeTempDir("agent-state-runtime-sleep-induction");
  const calls = createCalls();
  const agentState = createRuntime(root, calls);

  agentState.setState("sleeping", { reason: "sleep_started" });

  assert.equal(calls.sleepInductions, 1);
});

test("entering sleeping records an existing sleep cocoon preparation boundary", () => {
  const root = makeTempDir("agent-state-runtime-sleep-cocoon");
  const calls = createCalls();
  const agentState = createRuntime(root, calls);

  agentState.setState("going_to_sleep", {
    sleepCocoonEnteredAt: "2026-05-26T07:55:00.000",
    sleepCocoonEnteredAtUtc: "2026-05-25T23:55:00.000Z"
  });
  agentState.setState("sleeping", { reason: "sleep_started" });

  assert.deepEqual(calls.sleepPreparationBoundaries, [{
    occurredAt: "2026-05-26T07:55:00.000",
    occurredAtUtc: "2026-05-25T23:55:00.000Z",
    now: "2026-05-26T08:00:00.000",
    nowUtc: "2026-05-26T00:00:00.000Z"
  }]);
});

const dailyShell = {
  personality: { name: "P" },
  relationship: { name: "R" },
  outfit: { id: "o1", name: "O" },
  date: "2026-05-26"
};

function createRuntime(root: string, calls: ReturnType<typeof createCalls>, restartSandbox?: () => Promise<void>) {
  return createAgentStateRuntime({
    config: { memoryFiles: { root } },
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-05-26T00:00:00.000Z")),
    getDiaryStore: () => ({
      recordSleepBoundary(input: unknown) {
        calls.sleepBoundaries.push(input);
      },
      recordSleepPreparationBoundary(input: unknown) {
        calls.sleepPreparationBoundaries.push(input);
      },
      recordWakeBoundary(input: unknown) {
        calls.wakeBoundaries.push(input);
      }
    }),
    getDailyShellStore: () => ({
      reroll(date: Date, timeZone: string) {
        calls.rerolls.push({ dateIso: date.toISOString(), timeZone });
        return dailyShell;
      }
    }),
    clearLLMSession() {
      calls.clearedSessions += 1;
    },
    async sendSleepNotice() {
      calls.sleepNotices += 1;
    },
    async triggerSleepMemoryInduction() {
      calls.sleepInductions += 1;
    },
    queueMorningEvent() {
      calls.morningEvents += 1;
    },
    restartSandbox,
    attemptDailyOutfitOnBodyGeneration(daily) {
      calls.onBodyDailies.push(daily);
    },
    appendLog() {}
  });
}

function createCalls() {
  return {
    sleepBoundaries: [] as unknown[],
    sleepPreparationBoundaries: [] as unknown[],
    wakeBoundaries: [] as unknown[],
    rerolls: [] as Array<{ dateIso: string; timeZone: string }>,
    onBodyDailies: [] as unknown[],
    clearedSessions: 0,
    sleepNotices: 0,
    sleepInductions: 0,
    morningEvents: 0
  };
}

function writePersistedState(root: string, state: "sleeping"): void {
  const dir = path.join(root, "state");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "agent-state.json"), `${JSON.stringify({
    state,
    intimacy: 50,
    updatedAt: "2026-05-25T23:00:00.000",
    responseDelayMs: 8000
  }, null, 2)}\n`);
}

function makeTempDir(name: string): string {
  const dir = path.join(os.tmpdir(), "alice-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
