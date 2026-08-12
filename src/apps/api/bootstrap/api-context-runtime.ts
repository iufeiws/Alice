import { createAgentInitiatedBehaviorRunStore } from "../../../contexts/initiative/src/domain/initiated-behavior.js";
import { createCalendarStore } from "../../../platform/storage/src/calendar-store.js";
import { promptStoragePath } from "../../../contexts/agent-profile/src/adapters/json-prompt-profile-store.js";
import { createChannelStateRuntime } from "./channel-state-runtime.js";
import { createDefaultTargetResolver } from "./default-target-runtime.js";
import { createProfileMemoryRuntime } from "../../../contexts/memory/src/profile-memory-runtime.js";
import { createInitiatedBehaviorRuntime } from "../../../contexts/initiative/src/application/evaluate-triggers.js";
import { createSkillRegistry } from "../../../contexts/skills/src/index.js";
import { createPromptContextRuntime } from "../../../contexts/prompt-context/src/index.js";
import { addBashSandboxSkillMount, readSandboxNotesIndex } from "../../../contexts/bash-sandbox/src/index.js";
import { describeError } from "../../../shared/errors/src/index.js";

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

  const agentInitiatedBehaviorConfigPath = promptStoragePath(input.config.memoryFiles.root, "initiated-behaviors.config.json");
  const initiatedBehaviorRuntime = createInitiatedBehaviorRuntime({
    configPath: agentInitiatedBehaviorConfigPath,
    randomEventDir: "src/contexts/initiative/random-events",
    appendLog: input.appendLog
  });
  const initiatedBehaviorRunStore = createAgentInitiatedBehaviorRunStore({
    dbPath: path.join(input.config.memoryFiles.root, "state", "initiated-behavior-runs.sqlite")
  });
  const calendarStore = createCalendarStore(path.join(input.config.memoryFiles.root, "alice.sqlite"));
  const skillsDirPath = input.config.bashSandbox.skillsDir;
  const firstPartySkillsRoot = {
    root: input.config.skills?.root ?? "src/capabilities/skills",
    source: "first-party" as const,
    sandboxRoot: skillsDirPath
  };
  const skillsRegistry = createSkillRegistry({
    roots: [
      firstPartySkillsRoot,
      { root: input.config.skills?.installedRoot ?? ".agents/skills", source: "third-party", sandboxRoot: skillsDirPath }
    ]
  });
  for (const skill of createSkillRegistry({ roots: [firstPartySkillsRoot] }).list()) {
    addBashSandboxSkillMount(input.config.bashSandbox, {
      id: skill.name,
      hostPath: skill.hostRoot,
      containerPath: skill.sandboxRoot,
      readOnly: false
    });
  }
  const promptContextRuntime = createPromptContextRuntime({
    username: input.config.project.username,
    time: input.time,
    dailyShellStore: profileMemoryRuntime.dailyShellStore,
    coreProfileStore: profileMemoryRuntime.coreProfileStore,
    memoryStore: profileMemoryRuntime.memoryStore,
    diaryStore: profileMemoryRuntime.diaryStore,
    calendarStore,
    skillsRegistry,
    skillsDirPath,
    listNotes: () => {
      try {
        return readSandboxNotesIndex(input.config.bashSandbox, input.config.bashSandbox.notesDir);
      } catch (error) {
        input.appendLog("warn", `读取 sandbox 笔记索引失败: ${describeError(error)}`);
        return [];
      }
    }
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
    calendarStore,
    memoryInductionPromptStore: profileMemoryRuntime.memoryInductionPromptStore,
    sleepMemoryStateStore: profileMemoryRuntime.sleepMemoryStateStore,
    dailyShellStore: profileMemoryRuntime.dailyShellStore,
    skillsRegistry,
    promptContextRuntime,
    getAgentInitiatedBehaviorPlans: initiatedBehaviorRuntime.getPlans,
    createAgentInitiatedBehaviorConfig: initiatedBehaviorRuntime.createCustom,
    deleteAgentInitiatedBehaviorConfig: initiatedBehaviorRuntime.deleteCustom,
    setAgentInitiatedBehaviorConfig: initiatedBehaviorRuntime.setConfig,
    setAgentInitiatedBehaviorEnabled: initiatedBehaviorRuntime.setEnabled,
    randomEventStore: initiatedBehaviorRuntime.randomEvents,
    initiatedBehaviorRunStore
  };
}
