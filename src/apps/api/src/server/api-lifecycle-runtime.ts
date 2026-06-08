import { createDailyMaintenanceTasks, createDailyScheduler } from "../../../../core/scheduler/src/index.js";
import { createApiServerRuntime } from "./api-server-runtime.js";
import { createApiStartupRuntime, type ApiRuntimeState } from "../bootstrap/api-startup-runtime.js";

export type { ApiRuntimeState };

export function createApiLifecycleRuntime(input: {
  config: any;
  runtimeState: ApiRuntimeState;
  core: any;
  systemLogStore: any;
  time: any;
  ttsPlugin: any;
  messageRuntime: any;
  requestHandler: any;
  webRtcVoiceRuntime: any;
  serviceLock: { release(): void };
  appendLog(level: "info" | "warn" | "error", message: string): void;
  registerChannels(): void;
}) {
  input.registerChannels();

  const scheduler = createDailyScheduler(createDailyMaintenanceTasks({
    systemLogStore: input.systemLogStore,
    ttsOutputDirs: [input.config.tts.genieOutputDir, input.config.tts.mossOutputDir],
    nowIso: () => input.time.now().iso,
    log: input.appendLog
  }));

  const apiServerRuntime = createApiServerRuntime({
    config: input.config,
    requestHandler: input.requestHandler,
    appendLog: input.appendLog,
    attachVoiceSignaling: (servers, routes) => input.webRtcVoiceRuntime.attachSignalingServers(servers, routes),
    async onShutdown() {
      scheduler.stop();
      await input.ttsPlugin.voiceSynthesizer.shutdown?.();
      await input.messageRuntime.flushAll();
      await input.core.stop();
    },
    releaseLock: () => input.serviceLock.release()
  });

  const apiStartupRuntime = createApiStartupRuntime({
    config: input.config,
    runtimeState: input.runtimeState,
    core: input.core,
    scheduler,
    messageRuntime: input.messageRuntime,
    appendLog: input.appendLog
  });

  return {
    async start() {
      await apiStartupRuntime.start();
      apiServerRuntime.listen();
      apiServerRuntime.registerShutdownHandlers();
    }
  };
}
