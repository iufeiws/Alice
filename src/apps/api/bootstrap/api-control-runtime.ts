import { createApiContextRuntime } from "./api-context-runtime.js";
import { createApiNoticeRuntime } from "./api-notice-runtime.js";
import { createApiBehaviorRuntime } from "../../../contexts/initiative/src/application/api-initiated-behavior.js";
import { createOutfitOnBodyGenerationAttempt } from "../../../contexts/capabilities/src/outfit-on-body-runtime.js";
import type { ShortMemoryStore } from "../../../contexts/memory/src/short-memory-store.js";

export function createApiControlRuntime(input: {
  config: any;
  time: any;
  store: any;
  getChatAgent(): any;
  triggerSleepMemoryInduction(): Promise<unknown>;
  appendLog(level: "info" | "warn" | "error", message: string): void;
  appendMessageLog(input: any): unknown;
  shortMemoryStore: Pick<ShortMemoryStore, "listByCreatedAtUtcRange">;
}) {
  const apiContextRuntime = createApiContextRuntime({
    config: input.config,
    time: input.time,
    appendLog: input.appendLog,
    shortMemoryStore: input.shortMemoryStore
  });
  const apiNoticeRuntime = createApiNoticeRuntime({
    time: input.time,
    getStore: () => input.store,
    getDefaultTarget: () => apiContextRuntime.defaultTargetResolver.getDefaultMessagingTarget() as any,
    getDefaultFeishuTarget: () => apiContextRuntime.defaultTargetResolver.getDefaultFeishuTarget(),
    appendMessageLog: input.appendMessageLog
  });
  const attemptOutfitOnBodyGeneration = createOutfitOnBodyGenerationAttempt({
    config: input.config,
    dailyShellStore: apiContextRuntime.dailyShellStore,
    time: input.time,
    promptProfileStore: apiContextRuntime.promptProfileStore,
    coreProfileStore: apiContextRuntime.coreProfileStore,
    promptContextRuntime: apiContextRuntime.promptContextRuntime,
    appendLog: input.appendLog
  });
  const apiBehaviorRuntime = createApiBehaviorRuntime({
    config: input.config,
    time: input.time,
    getDiaryStore: () => apiContextRuntime.diaryStore,
    getCalendarStore: () => apiContextRuntime.calendarStore,
    getDailyShellStore: () => apiContextRuntime.dailyShellStore,
    clearLLMSession: () => input.getChatAgent().clearLLMSession("mode_transition"),
    sendSleepNotice: () => apiNoticeRuntime.outboundNoticeRuntime.sendSystemNoticeToDefaultTarget("少女已入眠"),
    triggerSleepMemoryInduction: input.triggerSleepMemoryInduction,
    getDefaultTarget: () => apiContextRuntime.defaultTargetResolver.getDefaultMessagingTarget() as any,
    attemptDailyOutfitOnBodyGeneration: (daily) => attemptOutfitOnBodyGeneration(daily.outfit),
    appendLog: input.appendLog
  });

  return {
    apiContextRuntime,
    apiNoticeRuntime,
    apiBehaviorRuntime,
    outputRouter: apiNoticeRuntime.outputRouter,
    outboundNoticeRuntime: apiNoticeRuntime.outboundNoticeRuntime,
    agentState: apiBehaviorRuntime.agentState,
    sleepCocoonEventRuntime: apiBehaviorRuntime.sleepCocoonEventRuntime,
    calendarEventRuntime: apiBehaviorRuntime.calendarEventRuntime
  };
}
