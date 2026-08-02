import { buildCalendarContext } from "../../../../capabilities/tools/calendar/src/index.js";
import { formatAvailableSkillsXml } from "../../../../contexts/skills/src/index.js";
import { defaultWorldWandererPluginConfigPath, readWorldWandererConfig } from "../../../../contexts/world-wanderer/src/index.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { PromptContextContentOption, PromptContextPrimitive, PromptContextRuntime, PromptContextValue } from "../contracts/prompt-context-runtime.js";

const memoryTargets = ["persistent", "userPreferences", "yesterdaySummary"] as const;
const optionFields = ["id", "name", "content", "group", "imageUrl", "onBodyImageUrl", "outfitImageGenerated", "onBodyGenerationAttempted"] as const;
const variableNames = [
  "user",
  "date_time",
  "date_time_utc",
  "time",
  "time_utc",
  "date",
  "date_utc",
  "weekday",
  "weekday_utc",
  "timezone",
  "appearance",
  "library/content",
  "dailyShell/date",
  "dailyShell/createdAt",
  ...optionFields.flatMap((field) => [`dailyShell/persona/${field}`, `dailyShell/relationship/${field}`, `outfit/${field}`]),
  ...memoryTargets.flatMap((target) => [
    `memory/${target}/content`,
    `memory/${target}/limit/lines`,
    `memory/${target}/limit/bytes`,
    `memory/${target}/limit/kib`
  ]),
  "wakeBoundary/occurredAt",
  "wakeBoundary/occurredAtUtc",
  "wakeBoundary/date",
  "wakeBoundary/weekday",
  "calendar/context",
  "skills/dirPath",
  "system_skills",
  "installed_skills"
];

export function createPromptContextRuntime(input: {
  username: string;
  time: CurrentTimeProvider;
  dailyShellStore: any;
  coreProfileStore: any;
  memoryStore: any;
  diaryStore: any;
  calendarStore: any;
  skillsRegistry: any;
  skillsDirPath: string;
  worldWandererConfigPath?: string;
}): PromptContextRuntime {
  return createRuntime(getVariable, () => [...variableNames]);

  function getVariable(name: string): PromptContextValue {
    if (name === "user") return input.username.trim() || "user";
    const time = timeVariable(name);
    if (time !== undefined) return time;
    if (name === "appearance") return coreProfile().appearanceDescription?.trim() || "";
    if (name === "library/content") return librarySetting();
    if (name.startsWith("dailyShell/")) return dailyShellVariable(name);
    if (name.startsWith("outfit/")) return optionVariable(dailyShell()?.outfit, name.slice("outfit/".length));
    if (name.startsWith("memory/")) return memoryVariable(name);
    if (name.startsWith("wakeBoundary/")) return wakeBoundaryVariable(name);
    if (name === "calendar/context") return calendarContext();
    if (name === "skills/dirPath") return input.skillsDirPath;
    if (name === "system_skills") return formatAvailableSkillsXml(input.skillsRegistry, "first-party", "system_skills");
    if (name === "installed_skills") return formatAvailableSkillsXml(input.skillsRegistry, "third-party", "installed_skills");
    return undefined;
  }

  function currentTime() {
    const now = input.time.now();
    const utc = now.date.toISOString();
    return {
      date_time: now.iso.slice(0, 19).replace("T", " "),
      date_time_utc: utc.slice(0, 19).replace("T", " "),
      time: now.iso.slice(11, 19),
      time_utc: utc.slice(11, 19),
      date: now.iso.slice(0, 10),
      date_utc: utc.slice(0, 10),
      weekday: formatWeekday(now.date, input.time.timeZone),
      weekday_utc: formatWeekday(now.date, "UTC"),
      timezone: input.time.timeZone,
      dateObject: now.date
    } as Record<string, string | Date>;
  }

  function timeVariable(name: string): PromptContextValue {
    if (!["date_time", "date_time_utc", "time", "time_utc", "date", "date_utc", "weekday", "weekday_utc", "timezone"].includes(name)) return undefined;
    return currentTime()[name] as string;
  }

  function coreProfile(): { appearanceDescription?: string; librarySetting?: string } {
    return input.coreProfileStore.get() as { appearanceDescription?: string; librarySetting?: string };
  }

  function librarySetting(): string {
    const worldWanderer = readWorldWandererConfig(input.worldWandererConfigPath ?? defaultWorldWandererPluginConfigPath);
    return worldWanderer.enabled ? worldWanderer.libraryPrompt : coreProfile().librarySetting ?? "";
  }

  function dailyShell(): { date: string; createdAt: string; personality: PromptContextContentOption; relationship: PromptContextContentOption; outfit: PromptContextContentOption } | undefined {
    return input.dailyShellStore.get(currentTime().dateObject, input.time.timeZone) as { date: string; createdAt: string; personality: PromptContextContentOption; relationship: PromptContextContentOption; outfit: PromptContextContentOption } | undefined;
  }

  function dailyShellVariable(name: string): PromptContextValue {
    const shell = dailyShell();
    const key = name.slice("dailyShell/".length);
    if (key === "date") return shell?.date ?? "";
    if (key === "createdAt") return shell?.createdAt ?? "";
    if (key.startsWith("persona/")) return optionVariable(shell?.personality, key.slice("persona/".length));
    if (key.startsWith("relationship/")) return optionVariable(shell?.relationship, key.slice("relationship/".length));
    return undefined;
  }

  function optionVariable(option: PromptContextContentOption | undefined, field: string): PromptContextValue {
    if (!optionFields.includes(field as (typeof optionFields)[number])) return undefined;
    const value = option?.[field as keyof PromptContextContentOption];
    if (typeof value === "boolean") return value;
    return value ?? "";
  }

  function memoryVariable(name: string): PromptContextValue {
    const [, target, field, metric] = name.split("/");
    if (!memoryTargets.includes(target as (typeof memoryTargets)[number])) return undefined;
    if (field === "content") return (input.memoryStore.read() as Record<string, string | undefined>)[target] ?? "";
    if (field === "limit" && (metric === "lines" || metric === "bytes" || metric === "kib")) return 0;
    return undefined;
  }

  function wakeBoundaryVariable(name: string): PromptContextValue {
    const boundary = input.diaryStore.latestWakeBoundary() as { occurredAt?: string; occurredAtUtc?: string } | undefined;
    const key = name.slice("wakeBoundary/".length);
    if (key === "occurredAt") return boundary?.occurredAt ?? "";
    if (key === "occurredAtUtc") return boundary?.occurredAtUtc ?? "";
    if (key === "date") return wakeBoundaryDate(boundary);
    if (key === "weekday") {
      const date = wakeBoundaryDate(boundary);
      if (!date) return "";
      const instant = boundary?.occurredAtUtc ? new Date(boundary.occurredAtUtc) : new Date(`${date}T12:00:00.000Z`);
      return formatWeekday(instant, boundary?.occurredAtUtc ? input.time.timeZone : "UTC");
    }
    return undefined;
  }

  function wakeBoundaryDate(boundary: { occurredAt?: string; occurredAtUtc?: string } | undefined): string {
    if (!boundary) return "";
    const instant = boundary.occurredAtUtc ? new Date(boundary.occurredAtUtc) : undefined;
    if (instant && Number.isFinite(instant.getTime())) return formatLocalDate(instant, input.time.timeZone);
    return boundary.occurredAt?.slice(0, 10) ?? "";
  }

  function calendarContext(): string {
    return buildCalendarContext({
      calendarStore: input.calendarStore,
      time: input.time,
      userName: input.username
    });
  }
}

function createRuntime(
  getVariable: (name: string) => PromptContextValue,
  listVariables: () => string[]
): PromptContextRuntime {
  const runtime: PromptContextRuntime = {
    renderText(content) {
      const unresolved = new Set<string>();
      const rendered = content.replace(/\{\{\s*([a-zA-Z0-9_/]+)\s*\}\}/g, (_match, key: string) => {
        const resolved = runtime.getVariable(key);
        if (resolved === undefined || resolved === null || typeof resolved === "object") {
          unresolved.add(key);
          return `{{${key}}}`;
        }
        return String(resolved);
      });
      if (unresolved.size) throw new Error(`unresolved prompt variable: ${[...unresolved].join(", ")}`);
      return rendered;
    },
    getVariable,
    listVariables,
    withVariables(variables) {
      const values = new Map<string, PromptContextPrimitive>(Object.entries(variables));
      return createRuntime(
        (name) => values.has(name) ? values.get(name) : runtime.getVariable(name),
        () => [...new Set([...runtime.listVariables(), ...values.keys()])]
      );
    }
  };
  return runtime;
}

function formatWeekday(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone, weekday: "long" }).format(date);
}

function formatLocalDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
