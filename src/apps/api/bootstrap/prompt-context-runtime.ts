import { buildCalendarContext } from "../../../capabilities/tools/calendar/src/index.js";
import { buildLLMTextVariables, type LLMTextVariables } from "../../../contexts/agent-profile/src/application/llm-text-renderer.js";
import { formatAvailableSkillsXml } from "../../../contexts/skills/src/index.js";
import { defaultWorldWandererPluginConfigPath, readWorldWandererConfig } from "../../../contexts/world-wanderer/src/index.js";
import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";

export type PromptContextRuntime = {
  getLibrarySetting(): string;
  getPromptVariables(): LLMTextVariables;
};

export function createPromptContextRuntime(input: {
  username: string;
  time: CurrentTimeProvider;
  dailyShellStore: any;
  coreProfileStore: any;
  memoryStore: any;
  diaryStore: any;
  calendarStore: any;
  skillsRegistry: any;
  worldWandererConfigPath?: string;
}): PromptContextRuntime {
  return {
    getLibrarySetting,
    getPromptVariables() {
      const now = input.time.now();
      return buildLLMTextVariables({
        userName: input.username,
        time: input.time,
        dailyShellRaw: input.dailyShellStore.get(now.date, input.time.timeZone),
        appearanceDescription: input.coreProfileStore.get().appearanceDescription,
        librarySetting: getLibrarySetting(),
        memory: input.memoryStore.read(),
        wakeBoundary: input.diaryStore.latestWakeBoundary(),
        calendarContext: buildCalendarContext({
          calendarStore: input.calendarStore,
          time: input.time,
          userName: input.username
        }),
        extra: {
          available_skills: formatAvailableSkillsXml(input.skillsRegistry)
        }
      });
    }
  };

  function getLibrarySetting(): string {
    const worldWanderer = readWorldWandererConfig(input.worldWandererConfigPath ?? defaultWorldWandererPluginConfigPath);
    return worldWanderer.enabled ? worldWanderer.libraryPrompt : input.coreProfileStore.get().librarySetting;
  }
}
