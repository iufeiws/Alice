import { buildCalendarContext } from "../../../../capabilities/tools/calendar/src/index.js";
import { formatAvailableSkillsXml, formatNotesXml, type NotesIndexEntry } from "../../../../contexts/skills/src/index.js";
import { defaultWorldWandererPluginConfigPath, readWorldWandererConfig } from "../../../../contexts/world-wanderer/src/index.js";
import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { ShortMemoryEntry, ShortMemoryStore } from "../../../../contexts/memory/src/short-memory-store.js";
import type { PromptContextContentOption, PromptContextPrimitive, PromptContextRuntime, PromptContextValue } from "../contracts/prompt-context-runtime.js";

const memoryTargets = ["persistent", "userPreferences", "yesterdaySummary"] as const;
// 计划 §9.2: 以最新 wake boundary 的 occurredAtUtc 为边界, 往前 24 小时构成查询窗口起点。
const SHORT_MEMORY_WINDOW_MS = 24 * 60 * 60 * 1000;
// 计划 §9.3: 无 wake boundary 或窗口内无记录时返回的固定空 XML。
const EMPTY_SHORT_MEMORIES_XML = "<short_memories></short_memories>";
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
  "selfie/pose",
  "selfie/hair",
  "selfie/composition",
  "selfie/expression",
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
  "memory/shortMemory/content",
  "wakeBoundary/occurredAt",
  "wakeBoundary/occurredAtUtc",
  "wakeBoundary/date",
  "wakeBoundary/weekday",
  "calendar/context",
  "skills/dirPath",
  "system_skills",
  "installed_skills",
  "notes_list"
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
  listNotes?: () => NotesIndexEntry[];
  worldWandererConfigPath?: string;
  shortMemoryStore: Pick<ShortMemoryStore, "listByCreatedAtUtcRange">;
  warn?: (message: string) => void;
}): PromptContextRuntime {
  return createRuntime(getVariable, () => [...variableNames], input.warn ?? ((message) => console.warn(message)));

  function getVariable(name: string): PromptContextValue {
    if (name === "user") return input.username.trim() || "user";
    const time = timeVariable(name);
    if (time !== undefined) return time;
    if (name === "appearance") return coreProfile().appearanceDescription?.trim() || "";
    if (name === "selfie/pose" || name === "selfie/hair" || name === "selfie/composition" || name === "selfie/expression") return "";
    if (name === "library/content") return librarySetting();
    if (name.startsWith("dailyShell/")) return dailyShellVariable(name);
    if (name.startsWith("outfit/")) return optionVariable(dailyShell()?.outfit, name.slice("outfit/".length));
    if (name.startsWith("memory/")) return memoryVariable(name);
    if (name.startsWith("wakeBoundary/")) return wakeBoundaryVariable(name);
    if (name === "calendar/context") return calendarContext();
    if (name === "skills/dirPath") return input.skillsDirPath;
    if (name === "system_skills") return formatAvailableSkillsXml(input.skillsRegistry, "first-party", "system_skills");
    if (name === "installed_skills") return formatAvailableSkillsXml(input.skillsRegistry, "third-party", "installed_skills");
    if (name === "notes_list") return input.listNotes ? formatNotesXml(input.listNotes()) : "";
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
    if (target === "shortMemory" && field === "content") return shortMemoryContent();
    if (!memoryTargets.includes(target as (typeof memoryTargets)[number])) return undefined;
    if (field === "content") return (input.memoryStore.read() as Record<string, string | undefined>)[target] ?? "";
    if (field === "limit" && (metric === "lines" || metric === "bytes" || metric === "kib")) return 0;
    return undefined;
  }

  /**
   * 计划 §9.2/§9.3: 最新 wake boundary 的 occurredAtUtc 前 24 小时至当前时间的闭区间查询。
   * 时间窗口全部基于 UTC epoch 计算(与现有 sleep-window / admin-runtime 的时间处理一致),
   * 不按字符串截取或本机时区计算; 无 wake boundary、boundary 缺 UTC 字段或未注入 store 时不查询。
   */
  function shortMemoryContent(): string {
    const boundary = input.diaryStore.latestWakeBoundary() as { occurredAtUtc?: string } | undefined;
    if (!boundary?.occurredAtUtc) return EMPTY_SHORT_MEMORIES_XML;
    const boundaryInstant = new Date(boundary.occurredAtUtc);
    if (!Number.isFinite(boundaryInstant.getTime())) return EMPTY_SHORT_MEMORIES_XML;
    const now = input.time.now();
    const entries = input.shortMemoryStore.listByCreatedAtUtcRange({
      startAtUtc: new Date(boundaryInstant.getTime() - SHORT_MEMORY_WINDOW_MS).toISOString(),
      endAtUtc: now.date.toISOString()
    });
    return formatShortMemoriesXml(entries);
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
  listVariables: () => string[],
  warn: (message: string) => void
): PromptContextRuntime {
  const runtime: PromptContextRuntime = {
    renderText(content) {
      const unresolved = new Set<string>();
      const rendered = content.replace(/\$\{\{\s*([a-zA-Z0-9_/]+)\s*\}\}/g, (match, key: string) => {
        const resolved = runtime.getVariable(key);
        if (resolved === undefined || resolved === null || typeof resolved === "object") {
          unresolved.add(key);
          return match;
        }
        return String(resolved);
      });
      if (unresolved.size) warn(`unresolved prompt variable: ${[...unresolved].join(", ")}; kept unchanged`);
      return rendered;
    },
    getVariable,
    listVariables,
    withVariables(variables) {
      const values = new Map<string, PromptContextPrimitive>(Object.entries(variables));
      return createRuntime(
        (name) => values.has(name) ? values.get(name) : runtime.getVariable(name),
        () => [...new Set([...runtime.listVariables(), ...values.keys()])],
        warn
      );
    }
  };
  return runtime;
}

function formatWeekday(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone, weekday: "long" }).format(date);
}

/**
 * 计划 §9.3: 按 store 返回顺序(createdAtUtc ASC, id ASC)输出 XML;
 * created_at 使用条目的本地 wall-clock createdAt 原样; 空结果返回固定空 XML。
 */
function formatShortMemoriesXml(entries: ShortMemoryEntry[]): string {
  if (!entries.length) return EMPTY_SHORT_MEMORIES_XML;
  const items = entries.map((entry) => [
    "  <short_memory>",
    `    <created_at>${escapeXmlText(entry.createdAt)}</created_at>`,
    `    <content>${escapeXmlText(entry.content)}</content>`,
    "  </short_memory>"
  ].join("\n")).join("\n");
  return `<short_memories>\n${items}\n</short_memories>`;
}

/** XML 文本转义: 至少覆盖 & < >; & 必须最先替换避免二次转义。 */
function escapeXmlText(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
