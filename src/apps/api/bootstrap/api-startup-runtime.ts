import type { AppConfig } from "../../../packages/config/src/index.js";

type AppendLog = (level: "info" | "warn" | "error", message: string) => void;

export type ApiRuntimeState = {
  feishuStarted: boolean;
  wechatStarted: boolean;
};

export function createApiStartupRuntime(input: {
  config: AppConfig;
  runtimeState: ApiRuntimeState;
  core: { start(): Promise<void> | void };
  scheduler: { start(): void };
  messageRuntime: { recoverPendingSessions(): void };
  appendLog: AppendLog;
}) {
  return {
    start
  };

  async function start(): Promise<void> {
    await input.core.start();
    input.scheduler.start();
    input.messageRuntime.recoverPendingSessions();
    input.runtimeState.feishuStarted = input.config.plugins.feishu.enabled && Object.keys(input.config.plugins.feishu.accounts).length > 0;
    input.runtimeState.wechatStarted = input.config.plugins.wechat.enabled && Boolean(input.config.plugins.wechat.botToken);
    input.appendLog("info", `agent core started: llm=api-preset feishu=${input.runtimeState.feishuStarted ? "started" : "stopped"} wechat=${input.runtimeState.wechatStarted ? "started" : "stopped"}`);
  }
}
