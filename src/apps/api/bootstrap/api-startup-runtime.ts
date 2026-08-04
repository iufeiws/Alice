import type { AppConfig } from "../../../apps/api/bootstrap/app-config-runtime.js";

type AppendLog = (level: "info" | "warn" | "error", message: string) => void;

export type ApiRuntimeState = {
  feishuStarted: boolean;
  wechatStarted: boolean;
};

export function createApiStartupRuntime(input: {
  config: AppConfig;
  runtimeState: ApiRuntimeState;
  chatAgent: { start(): Promise<void> | void };
  scheduler: { start(): void };
  messageRuntime: {
    recoverProcessRestartContinuation?(): Promise<void> | void;
    recoverPendingSessions(): void;
    pauseHeartbeat?(): void;
    resumeHeartbeat?(): void;
  };
  appendLog: AppendLog;
}) {
  return {
    start
  };

  async function start(): Promise<void> {
    const persistedHeartbeatPaused = input.config.core?.heartbeatPaused === true;
    input.messageRuntime.pauseHeartbeat?.();
    await input.chatAgent.start();
    await input.messageRuntime.recoverProcessRestartContinuation?.();
    input.scheduler.start();
    input.messageRuntime.recoverPendingSessions();
    input.messageRuntime.resumeHeartbeat?.();
    if (persistedHeartbeatPaused) {
      input.appendLog("info", "agent heartbeat resumed after startup: discarded stale heartbeat pause persisted by a previous run");
    }
    input.runtimeState.feishuStarted = input.config.plugins.feishu.enabled && Object.keys(input.config.plugins.feishu.accounts).length > 0;
    input.runtimeState.wechatStarted = input.config.plugins.wechat.enabled && Boolean(input.config.plugins.wechat.botToken);
    input.appendLog("info", `chat agent started: llm=api-preset feishu=${input.runtimeState.feishuStarted ? "started" : "stopped"} wechat=${input.runtimeState.wechatStarted ? "started" : "stopped"}`);
  }
}
