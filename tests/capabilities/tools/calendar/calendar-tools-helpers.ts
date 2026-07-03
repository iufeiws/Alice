import { createCurrentTimeProvider } from "../../../../src/platform/time/src/index.js";
import { createCalendarStore, type CalendarStore } from "../../../../src/platform/storage/src/calendar-store.js";
import { createCalendarTools } from "../../../../src/capabilities/tools/calendar/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");
const os = await import("node:os");

export function calendarStore(name: string): CalendarStore {
  fs.mkdirSync(path.join(os.tmpdir(), "alice-tests"), { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alice-tests", `${name}-`));
  return createCalendarStore(path.join(root, "alice.sqlite"));
}

export function calendarTools(input: {
  store: CalendarStore;
  timeZone?: string;
  now?: Date;
}) {
  return createCalendarTools({
    calendarStore: input.store,
    time: createCurrentTimeProvider(input.timeZone ?? "UTC", () => input.now ?? new Date("2026-06-22T00:00:00.000Z"))
  });
}

export function addSchedule(store: CalendarStore, input: {
  title: string;
  year?: number;
  day: number;
  time?: string;
  note?: string;
}): void {
  store.addEntry({
    kind: "schedule",
    title: input.title,
    note: input.note,
    calendarSystem: "gregorian",
    year: input.year,
    month: 6,
    day: input.day,
    time: input.time,
    now: "2026-06-22T00:00:00.000",
    nowUtc: "2026-06-22T00:00:00.000Z"
  });
}
