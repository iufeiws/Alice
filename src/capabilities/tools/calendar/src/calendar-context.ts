import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import { parseZonedIso } from "../../../../platform/time/src/index.js";
import type { CalendarDueDate, CalendarEntry, CalendarStore } from "../../../../platform/storage/src/calendar-store.js";
import { calendarDatesAt } from "./calendar-event-runtime.js";

export function buildCalendarContext(input: {
  calendarStore: CalendarStore;
  time: CurrentTimeProvider;
  userName?: string;
}): string {
  const today = input.time.now().iso.slice(0, 10);
  const entries = input.calendarStore.listEntries();
  const days: string[] = [];

  for (let offset = -5; offset <= 5; offset += 1) {
    const date = shiftLocalDate(today, offset);
    const instant = parseZonedIso(`${date}T12:00:00.000`, input.time.timeZone);
    const dates = calendarDatesAt(instant, input.time.timeZone);
    const matching = entries.filter((entry) => matchesAnyDate(entry, dates));
    const lines = [
      `${date} ${formatWeekday(instant, input.time.timeZone)} ${relativeDayText(offset)}`,
      ...(matching.length ? matching.map((entry) => formatCalendarEntry(entry, input.userName)) : ["无日程"])
    ];
    days.push(lines.join("\n"));
  }

  return `<calendar>\n${days.join("\n\n")}\n</calendar>`;
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
  if (offset === 0) return "今天";
  return offset < 0 ? `前${Math.abs(offset)}天` : `后${offset}天`;
}

function shiftLocalDate(localDate: string, offsetDays: number): string {
  const date = new Date(`${localDate}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function formatWeekday(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone, weekday: "long" }).format(date);
}
