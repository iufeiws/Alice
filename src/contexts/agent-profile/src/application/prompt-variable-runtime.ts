import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import { buildLLMTextVariables, type LLMTextVariables } from "./llm-text-renderer.js";
import { buildCalendarContext } from "../../../../capabilities/tools/calendar/src/index.js";

export type PromptVariableRuntime = {
  current(): LLMTextVariables;
  refresh(): LLMTextVariables;
  setUserName(userName: string): LLMTextVariables;
};

export function createPromptVariableRuntime(input: {
  time: CurrentTimeProvider;
  userName: string;
  dailyShellStore: any;
  coreProfileStore: any;
  getLibrarySetting?(): string;
  getAvailableSkills?(): string | undefined;
  memoryStore: any;
  diaryStore: any;
  calendarStore: any;
}): PromptVariableRuntime {
  let userName = input.userName;
  let variables = build();
  const timeRefresh = setInterval(updateTimeVariables, 1000);
  timeRefresh.unref?.();

  return {
    current() {
      return variables;
    },
    refresh() {
      variables = build();
      return variables;
    },
    setUserName(nextUserName) {
      userName = nextUserName;
      variables = build();
      return variables;
    }
  };

  function build(): LLMTextVariables {
    const now = input.time.now();
    return buildLLMTextVariables({
      userName,
      time: input.time,
      dailyShellRaw: input.dailyShellStore.get(now.date, input.time.timeZone),
      appearanceDescription: input.coreProfileStore.get().appearanceDescription,
      librarySetting: input.getLibrarySetting?.() ?? input.coreProfileStore.get().librarySetting,
      memory: input.memoryStore.read(),
      wakeBoundary: input.diaryStore.latestWakeBoundary(),
      calendarContext: buildCalendarContext({
        calendarStore: input.calendarStore,
        time: input.time,
        userName
      }),
      extra: {
        available_skills: input.getAvailableSkills?.() ?? ""
      }
    });
  }

  function timeVariables(): LLMTextVariables {
    const next = buildLLMTextVariables({ time: input.time });
    return {
      date_time: next.date_time,
      date_time_utc: next.date_time_utc,
      time: next.time,
      time_utc: next.time_utc,
      date: next.date,
      date_utc: next.date_utc,
      weekday: next.weekday,
      weekday_utc: next.weekday_utc,
      timezone: next.timezone
    };
  }

  function updateTimeVariables(): void {
    variables = { ...variables, ...timeVariables() };
  }
}
