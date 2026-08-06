import { createAgentStateController, createJsonAgentStateStore } from "../domain/agent-loop-state.js";

const path = await import("node:path");

export function createAgentStateRuntime(input: {
  config: any;
  time: any;
  getDiaryStore(): any;
  getDailyShellStore(): any;
  clearLLMSession(): void;
  sendSleepNotice(): Promise<void>;
  triggerSleepMemoryInduction(): Promise<unknown>;
  queueMorningEvent(): void;
  restartSandbox?(): Promise<void> | void;
  attemptDailyOutfitOnBodyGeneration?(daily: { outfit: any }): Promise<unknown> | unknown;
  appendLog(level: "info" | "warn" | "error", message: string): void;
}) {
  const agentState = createAgentStateController({
    store: createJsonAgentStateStore(path.join(input.config.memoryFiles.root, "state", "agent-state.json")),
    time: input.time,
    onPersistError(error) {
      input.appendLog("warn", `agent state persist failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  let wakeReady = Promise.resolve();
  let previousAgentBehaviorState = agentState.getSnapshot().state;
  agentState.onChange((snapshot) => {
    if (snapshot.state === "sleeping" && previousAgentBehaviorState !== "sleeping") {
      const now = input.time.now();
      const diaryStore = input.getDiaryStore();
      diaryStore.recordSleepBoundary({
        occurredAt: now.iso,
        occurredAtUtc: now.date.toISOString(),
        source: "sleep",
        now: now.iso,
        nowUtc: now.date.toISOString()
      });
      if (snapshot.sleepCocoonEnteredAt) {
        diaryStore.recordSleepPreparationBoundary({
          occurredAt: snapshot.sleepCocoonEnteredAt,
          occurredAtUtc: snapshot.sleepCocoonEnteredAtUtc,
          now: now.iso,
          nowUtc: now.date.toISOString()
        });
      }
      input.clearLLMSession();
      if (snapshot.reason === "sleep_started") void input.sendSleepNotice();
      void input.triggerSleepMemoryInduction();
    }
    if (previousAgentBehaviorState === "sleeping" && snapshot.state === "waiting") {
      const completeWake = () => {
        if (snapshot.reason !== "woke") return;
        const now = input.time.now();
        const diaryStore = input.getDiaryStore();
        diaryStore.recordWakeBoundary({
          occurredAt: now.iso,
          occurredAtUtc: now.date.toISOString(),
          now: now.iso,
          nowUtc: now.date.toISOString()
        });
        const daily = input.getDailyShellStore().reroll(now.date, input.time.timeZone);
        void input.attemptDailyOutfitOnBodyGeneration?.(daily);
        input.appendLog("info", `daily shell switched on wake: ${daily.personality.name}/${daily.relationship.name}/${daily.outfit.name} date=${daily.date}`);
        input.queueMorningEvent();
      };
      const restart = input.restartSandbox?.();
      if (restart && typeof (restart as Promise<void>).then === "function") {
        wakeReady = Promise.resolve(restart);
        void Promise.resolve(restart).then(completeWake, (error) => {
          input.appendLog("error", `pi sandbox restart on wake failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      } else {
        wakeReady = Promise.resolve();
        completeWake();
      }
    }
    previousAgentBehaviorState = snapshot.state;
  });

  return {
    ...agentState,
    waitForWake() {
      return wakeReady;
    }
  };
}
