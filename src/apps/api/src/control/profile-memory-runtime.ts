import type { AppConfig } from "../../../../packages/config/src/index.js";
import { createCoreProfileStore } from "../../../../core/agent/src/core-profile.js";
import {
  createMarkdownMemoryStore,
  createMemoryDiaryStore,
  createMemoryInductionPromptStore,
  createSleepMemoryStateStore
} from "../../../../core/agent/src/memory.js";
import { createPromptProfileStore } from "../../../../core/agent/src/prompts.js";
import { promptStoragePath } from "../../../../core/agent/src/prompt-storage.js";
import { createDailyShellStore } from "../../../../core/agent/src/shells.js";

const path = await import("node:path");

type AppendLog = (level: "info" | "warn" | "error", message: string) => void;

export function createProfileMemoryRuntime(input: {
  config: AppConfig;
  appendLog: AppendLog;
}) {
  const promptProfileStore = createPromptProfileStore(promptStoragePath(input.config.memoryFiles.root, "prompt-profile.json", ["config", "prompt-profile.json"]));
  const talkPromptProfileStore = createPromptProfileStore(promptStoragePath(input.config.memoryFiles.root, "talk-prompt-profile.json", ["config", "talk-prompt-profile.json"]));
  const coreProfileStore = createCoreProfileStore(path.join(input.config.memoryFiles.root, "config", "core-profile.json"));
  const memoryStore = createMarkdownMemoryStore(input.config.memoryFiles.root);
  const diaryStore = createMemoryDiaryStore(input.config.memoryFiles.root);
  memoryStore.ensure();
  const memoryInductionPromptStore = createMemoryInductionPromptStore(promptStoragePath(input.config.memoryFiles.root, "memorize-prompts.json", ["config", "memorize-prompts.json"]));
  promptStoragePath(input.config.memoryFiles.root, "memory-induction-prompts.json", ["config", "memory-induction-prompts.json"]);
  const sleepMemoryStateStore = createSleepMemoryStateStore(path.join(input.config.memoryFiles.root, "state", "sleep-memory-state.json"));
  const dailyShellStore = createDailyShellStore(input.config.memoryFiles.root, {
    promptTemplatePath: promptStoragePath(input.config.memoryFiles.root, "shell-prompt-template.txt", ["shell", "prompt-template.txt"]),
    onSwitch(entry) {
      input.appendLog("info", `daily shell switched: ${entry.message} outfit=${entry.outfitName} date=${entry.date}`);
    }
  });

  return {
    promptProfileStore,
    talkPromptProfileStore,
    coreProfileStore,
    memoryStore,
    diaryStore,
    memoryInductionPromptStore,
    sleepMemoryStateStore,
    dailyShellStore
  };
}
