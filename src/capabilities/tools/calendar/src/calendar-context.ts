import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import { parseZonedIso } from "../../../../platform/time/src/index.js";
import type { CalendarDueDate, CalendarEntry, CalendarStore } from "../../../../platform/storage/src/calendar-store.js";
import { calendarDatesAt } from "./calendar-event-runtime.js";

export function buildCalendarContext(input: {
  calendarStore: CalendarStore;
  time: CurrentTimeProvider;
  userName?: string;
  daysBefore?: number;
  daysAfter?: number;
  includeEmptyDays?: boolean;
  localDates?: string[];
}): string {
  const today = input.time.now().iso.slice(0, 10);
  const entries = input.calendarStore.listEntries();
  const days: string[] = [];
  const offsets = input.localDates
    ? input.localDates.map((date) => daysBetween(today, date))
    : rangeOffsets(input.daysBefore ?? 5, input.daysAfter ?? 5);

  for (const offset of offsets) {
    const date = shiftLocalDate(today, offset);
    const instant = parseZonedIso(`${date}T12:00:00.000`, input.time.timeZone);
    const dates = calendarDatesAt(instant, input.time.timeZone);
    const matching = entries.filter((entry) => matchesAnyDate(entry, dates));
    if (matching.length === 0 && !input.includeEmptyDays) continue;
    const lines = [
      `${date} ${formatWeekday(instant, input.time.timeZone)} ${relativeDayText(offset)}`,
      ...(matching.length ? matching.map((entry) => formatCalendarEntry(entry, input.userName)) : ["-空-"])
    ];
    days.push(lines.join("\n"));
  }

  return `<calendar>\n${days.length ? days.join("\n\n") : "-空-"}\n</calendar>`;
}

function matchesAnyDate(entry: CalendarEntry, dates: CalendarDueDate[]): boolean {
  return dates.some((date) => {
    if (entry.calendarSystem !== date.calendarSystem) return false;
    if (entry.year !== undefined && entry.year !== date.year) return false;
    return entry.month === date.month
      && entry.day === date.day
      && entry.isLeapMonth === Boolean(date.isLeapMonth);
  });
}

function formatCalendarEntry(entry: CalendarEntry, userName: string | undefined): string {
  const title = entry.kind === "birthday" && entry.title === "birthday"
    ? `${userName?.trim() || "user"} 的生日`
    : entry.title;
  const text = [entry.time, title, entry.note].filter((part) => part && part.trim()).join(" ");
  return text || title;
}

function relativeDayText(offset: number): string {
  if (offset === -2) return "前天";
  if (offset === -1) return "昨天";
  if (offset === 0) return "今天";
  if (offset === 1) return "明天";
  if (offset === 2) return "后天";
  return offset < 0 ? `${Math.abs(offset)}天前` : `${offset}天后`;
}

function shiftLocalDate(localDate: string, offsetDays: number): string {
  const date = new Date(`${localDate}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function rangeOffsets(daysBefore: number, daysAfter: number): number[] {
  const offsets: number[] = [];
  for (let offset = -daysBefore; offset <= daysAfter; offset += 1) offsets.push(offset);
  return offsets;
}

function daysBetween(fromLocalDate: string, toLocalDate: string): number {
  const from = new Date(`${fromLocalDate}T12:00:00.000Z`).getTime();
  const to = new Date(`${toLocalDate}T12:00:00.000Z`).getTime();
  return Math.round((to - from) / 86_400_000);
}

function formatWeekday(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone, weekday: "long" }).format(date);
}
