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

test("entering sleeping sends a sleep notice", async () => {
  const root = makeTempDir("agent-state-runtime-sleep-notice");
  const calls = createCalls();
  const agentState = createRuntime(root, calls);

  agentState.setState("sleeping", { reason: "sleep_started" });

  await waitFor(() => calls.sleepNotices === 1);
});

test("entering sleeping triggers sleep memory induction", async () => {
  const root = makeTempDir("agent-state-runtime-sleep-induction");
  const calls = createCalls();
  const agentState = createRuntime(root, calls);

  agentState.setState("sleeping", { reason: "sleep_started" });

  await waitFor(() => calls.sleepInductions === 1);
});

test("entering sleeping awaits the clear before notice and induction, in order", async () => {
  const root = makeTempDir("agent-state-runtime-sleep-clear-gate");
  const calls = createCalls();
  let releaseClear: (() => void) | undefined;
  const clearGate = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  const agentState = createRuntime(root, calls, {
    clearLLMSession: () => {
      calls.events.push("clear");
      return clearGate;
    }
  });

  agentState.setState("sleeping", { reason: "sleep_started" });
  await waitFor(() => calls.events.includes("clear"));

  await sleep(60);
  assert.deepEqual(calls.events, ["clear"], "clear Promise 完成前不得触发通知与记忆归纳(§11.2)");
  assert.equal(calls.sleepNotices, 0, "clear 完成前不得发送睡眠通知");
  assert.equal(calls.sleepInductions, 0, "clear 完成前不得触发记忆归纳");

  releaseClear?.();
  await waitFor(() => calls.events.includes("notice") && calls.events.includes("induction"));
  assert.deepEqual(calls.events, ["clear", "notice", "induction"], "成功后才按序触发通知与归纳");
});

test("entering sleeping clear failure blocks notice and induction and records the error", async () => {
  const root = makeTempDir("agent-state-runtime-sleep-clear-fail");
  const calls = createCalls();
  const agentState = createRuntime(root, calls, {
    clearLLMSession: () => {
      calls.events.push("clear");
      return Promise.reject(new Error("sleep clear boom"));
    }
  });

  agentState.setState("sleeping", { reason: "sleep_started" });
  await waitFor(() => calls.events.includes("clear"));
  await sleep(60);

  assert.equal(calls.sleepNotices, 0, "清除失败时不得发送睡眠通知");
  assert.equal(calls.sleepInductions, 0, "清除失败时不得触发记忆归纳(阻止后续 loop)");
  assert.equal(
    calls.logLines.some((line) => line.includes("sleep transition llm session clear failed") && line.includes("sleep clear boom")),
    true,
    "清除失败必须记录错误日志"
  );
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

function createRuntime(root: string, calls: ReturnType<typeof createCalls>, options: {
  clearLLMSession?: () => void | Promise<void>;
} = {}) {
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
    clearLLMSession: options.clearLLMSession ?? (() => {
      calls.events.push("clear");
      calls.clearedSessions += 1;
    }),
    async sendSleepNotice() {
      calls.events.push("notice");
      calls.sleepNotices += 1;
    },
    async triggerSleepMemoryInduction() {
      calls.events.push("induction");
      calls.sleepInductions += 1;
    },
    queueMorningEvent() {
      calls.morningEvents += 1;
    },
    attemptDailyOutfitOnBodyGeneration(daily) {
      calls.onBodyDailies.push(daily);
    },
    appendLog(level, message) {
      calls.logLines.push(`${level}:${message}`);
    }
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
    morningEvents: 0,
    events: [] as string[],
    logLines: [] as string[]
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("condition was not met before timeout");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
