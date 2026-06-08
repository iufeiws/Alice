import { createAgentInitiatedBehaviorRunStore } from "../../../../core/agent/src/initiated-behaviors.js";
import { promptStoragePath } from "../../../../core/agent/src/prompt-storage.js";
import { createChannelStateRuntime } from "./channel-state-runtime.js";
import { createDefaultTargetResolver } from "../../../../tools/messaging/src/default-target-runtime.js";
import { createProfileMemoryRuntime } from "./profile-memory-runtime.js";
import { createInitiatedBehaviorRuntime } from "../../../../core/agent/src/initiated-behavior-runtime.js";

const path = await import("node:path");

export function createApiContextRuntime(input: {
  config: any;
  time: any;
  appendLog(level: "info" | "warn" | "error", message: string): void;
}) {
  const channelStateRuntime = createChannelStateRuntime({
    config: input.config,
    time: input.time
  });
  const feishuPairingStore = channelStateRuntime.feishuPairingStore;
  const wechatStateStore = channelStateRuntime.wechatStateStore;
  const defaultTargetResolver = createDefaultTargetResolver({
    config: input.config,
    feishuPairingStore,
    wechatStateStore
  });

  const profileMemoryRuntime = createProfileMemoryRuntime({
    config: input.config,
    appendLog: input.appendLog
  });

  const agentInitiatedBehaviorConfigPath = promptStoragePath(input.config.memoryFiles.root, "initiated-behaviors.config.json", ["config", "initiated-behaviors.config.json"]);
  const initiatedBehaviorRuntime = createInitiatedBehaviorRuntime({
    configPath: agentInitiatedBehaviorConfigPath,
    appendLog: input.appendLog
  });
  const initiatedBehaviorRunStore = createAgentInitiatedBehaviorRunStore({
    dbPath: path.join(input.config.memoryFiles.root, "state", "initiated-behavior-runs.sqlite")
  });

  return {
    feishuPairingStore,
    wechatStateStore,
    defaultTargetResolver,
    promptProfileStore: profileMemoryRuntime.promptProfileStore,
    talkPromptProfileStore: profileMemoryRuntime.talkPromptProfileStore,
    coreProfileStore: profileMemoryRuntime.coreProfileStore,
    memoryStore: profileMemoryRuntime.memoryStore,
    diaryStore: profileMemoryRuntime.diaryStore,
    memoryInductionPromptStore: profileMemoryRuntime.memoryInductionPromptStore,
    sleepMemoryStateStore: profileMemoryRuntime.sleepMemoryStateStore,
    dailyShellStore: profileMemoryRuntime.dailyShellStore,
    getAgentInitiatedBehaviorPlans: initiatedBehaviorRuntime.getPlans,
    setAgentInitiatedBehaviorConfig: initiatedBehaviorRuntime.setConfig,
    setAgentInitiatedBehaviorEnabled: initiatedBehaviorRuntime.setEnabled,
    initiatedBehaviorRunStore
  };
}
