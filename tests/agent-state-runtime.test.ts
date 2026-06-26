import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentStateRuntime } from "../src/contexts/agent-loop/src/runtime/agent-state-runtime.js";
import { createCurrentTimeProvider } from "../src/platform/time/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("agent state wake reroll attempts daily outfit on-body generation", () => {
  const root = makeTempDir("agent-state-runtime-on-body");
  const daily = {
    personality: { name: "P" },
    relationship: { name: "R" },
    outfit: { id: "o1", name: "O" },
    date: "2026-05-26"
  };
  const attempted: string[] = [];
  const agentState = createAgentStateRuntime({
    config: { memoryFiles: { root } },
    time: createCurrentTimeProvider("UTC", () => new Date("2026-05-26T00:00:00.000Z")),
    getDiaryStore: () => ({
      recordSleepBoundary() {},
      recordSleepPreparationBoundary() {},
      recordWakeBoundary() {}
    }),
    getDailyShellStore: () => ({ reroll: () => daily }),
    clearLLMSession() {},
    async sendSleepNotice() {},
    async triggerSleepMemoryInduction() {},
    queueMorningEvent() {},
    attemptDailyOutfitOnBodyGeneration(input) {
      attempted.push((input.outfit as { id: string }).id);
    },
    appendLog() {}
  });

  agentState.setState("sleeping");
  agentState.setState("waiting", { reason: "woke" });

  assert.deepEqual(attempted, ["o1"]);
});

function makeTempDir(name: string): string {
  const dir = path.join(process.cwd(), ".tmp-tests", `alice-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
