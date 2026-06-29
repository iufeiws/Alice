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
  messageRuntime: { recoverPendingSessions(): void };
  appendLog: AppendLog;
}) {
  return {
    start
  };

  async function start(): Promise<void> {
    await input.chatAgent.start();
    input.scheduler.start();
    input.messageRuntime.recoverPendingSessions();
    input.runtimeState.feishuStarted = input.config.plugins.feishu.enabled && Object.keys(input.config.plugins.feishu.accounts).length > 0;
    input.runtimeState.wechatStarted = input.config.plugins.wechat.enabled && Boolean(input.config.plugins.wechat.botToken);
    input.appendLog("info", `chat agent started: llm=api-preset feishu=${input.runtimeState.feishuStarted ? "started" : "stopped"} wechat=${input.runtimeState.wechatStarted ? "started" : "stopped"}`);
  }
}
