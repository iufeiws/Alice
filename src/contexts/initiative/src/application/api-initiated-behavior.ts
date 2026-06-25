import { createAgentStateRuntime } from "../../../agent-loop/src/runtime/agent-state-runtime.js";
import { createSleepCocoonEventRuntime } from "../../../../capabilities/tools/sleep-cocoon/src/sleep-cocoon-event-runtime.js";
import { createCalendarEventRuntime } from "../../../../capabilities/tools/calendar/src/calendar-event-runtime.js";

export function createApiBehaviorRuntime(input: {
  config: any;
  time: any;
  getDiaryStore(): any;
  getCalendarStore(): any;
  getDailyShellStore(): any;
  clearLLMSession(): void;
  sendSleepNotice(): Promise<void>;
  triggerSleepMemoryInduction(): Promise<unknown>;
  getDefaultTarget(): any;
  appendLog(level: "info" | "warn" | "error", message: string): void;
}) {
  let sleepCocoonEventRuntime: any;
  const agentState = createAgentStateRuntime({
    config: input.config,
    time: input.time,
    getDiaryStore: input.getDiaryStore,
    getDailyShellStore: input.getDailyShellStore,
    clearLLMSession: input.clearLLMSession,
    sendSleepNotice: input.sendSleepNotice,
    triggerSleepMemoryInduction: input.triggerSleepMemoryInduction,
    queueMorningEvent: () => sleepCocoonEventRuntime.queueMorningEvent({ agentInitiatedTriggerEvent: "sleep_cocoon.wake" }),
    appendLog: input.appendLog
  });
  sleepCocoonEventRuntime = createSleepCocoonEventRuntime({
    agentState,
    time: input.time,
    getDefaultTarget: input.getDefaultTarget
  });
  const calendarEventRuntime = createCalendarEventRuntime({
    calendarStore: input.getCalendarStore(),
    time: input.time,
    getDefaultTarget: input.getDefaultTarget
  });

  return { agentState, sleepCocoonEventRuntime, calendarEventRuntime };
}
