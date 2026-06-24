import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import type { ToolCall, ToolPlugin, ToolResult } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import { parseZonedIso } from "../../../../platform/time/src/index.js";
import type { CalendarEntry, CalendarStore } from "../../../../platform/storage/src/calendar-store.js";
import { calendarTool, calendarToolText } from "../profile.js";
import { buildCalendarContext } from "./calendar-context.js";

export * from "./calendar-event-runtime.js";
export * from "./calendar-context.js";

export type CalendarToolsDeps = {
  calendarStore: CalendarStore;
  time: CurrentTimeProvider;
};

type ParsedDatetime = {
  date: string;
  year: number;
  month: number;
  day: number;
  time?: string;
};

export function createCalendarTools(deps: CalendarToolsDeps): ToolPlugin {
  return {
    id: "calendar",
    listTools() {
      return [calendarTool];
    },
    async execute(call) {
      if (call.toolName !== "calendar") return toolError(call, calendarToolText.unknownTool(call.toolName));
      const action = stringValue(call.input.action);
      if (action === "list") return listEntries(call);
      if (action === "search") return searchEntries(call);
      if (action === "add") return addEntry(call);
      if (action === "remove") return removeEntry(call);
      return toolError(call, calendarToolText.unsupportedAction);
    }
  };

  function addEntry(call: ToolCall): ToolResult {
    const title = stringValue(call.input.title).trim();
    if (!title) return toolError(call, calendarToolText.invalidTitle);
    const now = deps.time.now();
    const datetime = parseDatetime(call.input.datetime);
    if (!datetime) return toolError(call, calendarToolText.invalidDatetime);
    if (!isFutureOrNow(datetime, now.epochMs, now.iso, deps.time.timeZone)) return toolError(call, calendarToolText.pastDatetime);
    if (findScheduleByTitleAndDatetime(title, datetime)) return toolError(call, calendarToolText.duplicateSchedule);
    const entry = deps.calendarStore.addEntry({
      kind: "schedule",
      title,
      note: stringValue(call.input.note),
      calendarSystem: "gregorian",
      year: datetime.year,
      month: datetime.month,
      day: datetime.day,
      time: datetime.time,
      now: now.iso,
      nowUtc: now.date.toISOString()
    });
    return {
      callId: call.id,
      ok: true,
      output: { entry, calendar: renderDay(datetime.date) }
    };
  }

  function removeEntry(call: ToolCall): ToolResult {
    const title = stringValue(call.input.title).trim();
    if (!title) return toolError(call, calendarToolText.invalidTitle);
    const datetime = parseDatetime(call.input.datetime);
    if (!datetime) return toolError(call, calendarToolText.invalidDatetime);
    const now = deps.time.now();
    if (!isFutureOrNow(datetime, now.epochMs, now.iso, deps.time.timeZone)) return toolError(call, calendarToolText.pastDatetime);
    const future = futureSchedules(now.epochMs, now.iso);
    const datetimeMatches = future.filter((entry) => sameDatetime(entry, datetime));
    const titleMatches = future.filter((entry) => entry.title === title);
    const exact = datetimeMatches.filter((entry) => entry.title === title);
    const target = exact.length === 1
      ? exact[0]
      : datetimeMatches.length === 1 && titleMatches.length !== 1
        ? datetimeMatches[0]
        : titleMatches.length === 1 && datetimeMatches.length !== 1
          ? titleMatches[0]
          : undefined;
    if (target) {
      const removed = deps.calendarStore.removeEntry(target.id)!;
      return {
        callId: call.id,
        ok: true,
        output: { removed, calendar: renderDay(entryDate(removed)) }
      };
    }
    return {
      callId: call.id,
      ok: false,
      error: calendarToolText.notFound,
      output: {
        datetimeMatches: farToNear(datetimeMatches, now.epochMs, deps.time.timeZone).slice(0, 5).map(calendarEntryOutput),
        titleMatches: farToNear(future.filter((entry) => fuzzyIncludes(entry.title, title)), now.epochMs, deps.time.timeZone).slice(0, 5).map(calendarEntryOutput)
      }
    };
  }

  function listEntries(call: ToolCall): ToolResult {
    return {
      callId: call.id,
      ok: true,
      output: buildCalendarContext({
        calendarStore: deps.calendarStore,
        time: deps.time,
        daysBefore: integerInRange(call.input.daysBefore, 0, 30) ?? 5,
        daysAfter: integerInRange(call.input.daysAfter, 0, 30) ?? 5,
        includeEmptyDays: true
      })
    };
  }

  function searchEntries(call: ToolCall): ToolResult {
    const keys = searchKeys(call.input.searchkey);
    if (keys.length === 0) return toolError(call, calendarToolText.invalidSearch);
    const scope = stringValue(call.input.scope) || "future";
    if (scope !== "future" && scope !== "past" && scope !== "both") return toolError(call, calendarToolText.invalidSearch);
    const now = deps.time.now();
    const entries = deps.calendarStore.listEntries()
      .filter((entry) => entry.kind === "schedule")
      .filter((entry) => scopeMatches(entry, scope, now.epochMs, now.iso, deps.time.timeZone))
      .filter((entry) => keys.some((key) => searchableText(entry).some((value) => fuzzyIncludes(value, key))));
    return {
      callId: call.id,
      ok: true,
      output: entries.sort((a, b) => distanceFromNow(a, now.epochMs, deps.time.timeZone) - distanceFromNow(b, now.epochMs, deps.time.timeZone)).slice(0, 10).map(calendarEntryOutput)
    };
  }

  function renderDay(localDate: string): string {
    return buildCalendarContext({
      calendarStore: deps.calendarStore,
      time: deps.time,
      localDates: [localDate],
      includeEmptyDays: true
    });
  }

  function findScheduleByTitleAndDatetime(title: string, datetime: ParsedDatetime): CalendarEntry | undefined {
    return deps.calendarStore.listEntries("schedule").find((entry) => entry.title === title && sameDatetime(entry, datetime));
  }

  function futureSchedules(nowMs: number, nowIso: string): CalendarEntry[] {
    return deps.calendarStore.listEntries("schedule").filter((entry) => entryIsFutureOrNow(entry, nowMs, nowIso, deps.time.timeZone));
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integerInRange(value: unknown, min: number, max: number): number | undefined {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(numeric) && numeric >= min && numeric <= max ? numeric : undefined;
}

function toolError(call: ToolCall, error: string): ToolResult {
  return { callId: call.id, ok: false, error };
}

function parseDatetime(value: unknown): ParsedDatetime | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]([01][0-9]|2[0-3]):([0-5][0-9]))?$/.exec(value.trim());
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = match[4] && match[5] ? `${match[4]}:${match[5]}` : undefined;
  const check = new Date(Date.UTC(year, month - 1, day, 12));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return undefined;
  return { date: `${match[1]}-${match[2]}-${match[3]}`, year, month, day, time };
}

function isFutureOrNow(datetime: ParsedDatetime, nowMs: number, nowIso: string, timeZone: string): boolean {
  if (!datetime.time) return datetime.date >= nowIso.slice(0, 10);
  return parseZonedIso(`${datetime.date}T${datetime.time}:00.000`, timeZone).getTime() >= nowMs;
}

function entryIsFutureOrNow(entry: CalendarEntry, nowMs: number, nowIso: string, timeZone: string): boolean {
  if (!entry.time) return entryDate(entry) >= nowIso.slice(0, 10);
  return entryInstant(entry, timeZone).getTime() >= nowMs;
}

function scopeMatches(entry: CalendarEntry, scope: string, nowMs: number, nowIso: string, timeZone: string): boolean {
  if (scope === "both") return true;
  const future = entryIsFutureOrNow(entry, nowMs, nowIso, timeZone);
  return scope === "future" ? future : !future;
}

function sameDatetime(entry: CalendarEntry, datetime: ParsedDatetime): boolean {
  return entry.year === datetime.year
    && entry.month === datetime.month
    && entry.day === datetime.day
    && (entry.time ?? "") === (datetime.time ?? "");
}

function entryDate(entry: CalendarEntry): string {
  return `${String(entry.year).padStart(4, "0")}-${String(entry.month).padStart(2, "0")}-${String(entry.day).padStart(2, "0")}`;
}

function entryDateTime(entry: CalendarEntry): string {
  return entry.time ? `${entryDate(entry)} ${entry.time}` : entryDate(entry);
}

function entryInstant(entry: CalendarEntry, timeZone: string): Date {
  return parseZonedIso(`${entryDate(entry)}T${entry.time ?? "00:00"}:00.000`, timeZone);
}

function distanceFromNow(entry: CalendarEntry, nowMs: number, timeZone: string): number {
  return Math.abs(entryInstant(entry, timeZone).getTime() - nowMs);
}

function farToNear(entries: CalendarEntry[], nowMs: number, timeZone: string): CalendarEntry[] {
  return [...entries].sort((a, b) => distanceFromNow(b, nowMs, timeZone) - distanceFromNow(a, nowMs, timeZone));
}

function fuzzyIncludes(value: string, key: string): boolean {
  return value.toLowerCase().includes(key.toLowerCase());
}

function searchableText(entry: CalendarEntry): string[] {
  return [entry.title, entry.note, entryDate(entry), entry.time ?? "", entryDateTime(entry)].filter(Boolean);
}

function searchKeys(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  return raw.map((entry) => stringValue(entry).trim()).filter(Boolean);
}

function calendarEntryOutput(entry: CalendarEntry): Record<string, unknown> {
  return {
    title: entry.title,
    datetime: entryDateTime(entry),
    note: entry.note || undefined
  };
}
