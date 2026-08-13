import { createAgentStateController, createJsonAgentStateStore } from "../domain/agent-loop-state.js";

const path = await import("node:path");

export function createAgentStateRuntime(input: {
  config: any;
  time: any;
  getDiaryStore(): any;
  getDailyShellStore(): any;
  clearLLMSession(): void | Promise<void>;
  sendSleepNotice(): Promise<void>;
  triggerSleepMemoryInduction(): Promise<unknown>;
  queueMorningEvent(): void;
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

  let previousAgentBehaviorState = agentState.getSnapshot().state;
  agentState.onChange(async (snapshot) => {
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
      // §7.1: mode_transition 清除进入统一协调器(含 Short Memory 采集)。
      // §10/§11.2: 必须先 await 清除完成, 成功后才触发睡眠通知与记忆归纳;
      // 清除失败时记录错误, 不触发通知与归纳(阻止后续 loop)。
      try {
        await input.clearLLMSession();
      } catch (error) {
        input.appendLog("error", `sleep transition llm session clear failed: ${error instanceof Error ? error.message : String(error)}`);
        previousAgentBehaviorState = snapshot.state;
        return;
      }
      if (snapshot.reason === "sleep_started") await input.sendSleepNotice();
      await input.triggerSleepMemoryInduction();
    }
    if (previousAgentBehaviorState === "sleeping" && snapshot.state === "waiting") {
      if (snapshot.reason === "woke") {
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
      }
    }
    previousAgentBehaviorState = snapshot.state;
  });

  return {
    ...agentState,
    waitForWake() {
      // worker 不在 wake 流程中; wake 立即完成。
      return Promise.resolve();
    }
  };
}
