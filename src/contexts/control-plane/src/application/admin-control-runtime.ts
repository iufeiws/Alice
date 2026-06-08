import { createApiContextRuntime } from "../../../../core/agent/src/api-context-runtime.js";
import { createApiNoticeRuntime } from "../../../../tools/messaging/src/api-notice-runtime.js";
import { createApiBehaviorRuntime } from "../../../initiative/src/application/api-initiated-behavior.js";

export function createApiControlRuntime(input: {
  config: any;
  time: any;
  store: any;
  getCore(): any;
  triggerSleepMemoryInduction(): Promise<unknown>;
  appendLog(level: "info" | "warn" | "error", message: string): void;
  appendMessageLog(input: any): unknown;
}) {
  const apiContextRuntime = createApiContextRuntime({
    config: input.config,
    time: input.time,
    appendLog: input.appendLog
  });
  const apiNoticeRuntime = createApiNoticeRuntime({
    time: input.time,
    getStore: () => input.store,
    getDefaultTarget: () => apiContextRuntime.defaultTargetResolver.getDefaultMessagingTarget() as any,
    getDefaultFeishuTarget: () => apiContextRuntime.defaultTargetResolver.getDefaultFeishuTarget(),
    appendMessageLog: input.appendMessageLog
  });
  const apiBehaviorRuntime = createApiBehaviorRuntime({
    config: input.config,
    time: input.time,
    getDiaryStore: () => apiContextRuntime.diaryStore,
    getDailyShellStore: () => apiContextRuntime.dailyShellStore,
    clearLLMSession: () => input.getCore().clearLLMSession("mode_transition"),
    sendSleepNotice: () => apiNoticeRuntime.outboundNoticeRuntime.sendSystemNoticeToDefaultTarget("-少女已入眠-"),
    triggerSleepMemoryInduction: input.triggerSleepMemoryInduction,
    getDefaultTarget: () => apiContextRuntime.defaultTargetResolver.getDefaultMessagingTarget() as any,
    appendLog: input.appendLog
  });

  return {
    apiContextRuntime,
    apiNoticeRuntime,
    apiBehaviorRuntime,
    outputRouter: apiNoticeRuntime.outputRouter,
    outboundNoticeRuntime: apiNoticeRuntime.outboundNoticeRuntime,
    agentState: apiBehaviorRuntime.agentState,
    sleepCocoonEventRuntime: apiBehaviorRuntime.sleepCocoonEventRuntime
  };
}
