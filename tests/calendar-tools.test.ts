import { test } from "node:test";
import assert from "node:assert/strict";
import { createCurrentTimeProvider } from "../src/platform/time/src/index.js";
import { createCalendarStore } from "../src/platform/storage/src/calendar-store.js";
import { buildCalendarContext, createCalendarEventRuntime, createCalendarTools } from "../src/capabilities/tools/calendar/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

test("calendar store creates calendar_entries in alice sqlite", () => {
  const store = createCalendarStore(dbPath("calendar-store-init"));
  assert.deepEqual(store.listEntries(), []);
});

test("calendar tool adds and removes holiday", async () => {
  const store = createCalendarStore(dbPath("calendar-holiday"));
  const tools = createCalendarTools({
    calendarStore: store,
    time: createCurrentTimeProvider("Asia/Tokyo", () => new Date("2026-06-22T00:00:00.000Z"))
  });

  const added = await tools.execute({
    id: "call_add_holiday",
    toolName: "calendar",
    input: { action: "add", type: "holiday", calendarSystem: "gregorian", title: "holiday", month: 6, day: 22 }
  });

  assert.equal(added.ok, true);
  assert.equal((added.output as { kind: string }).kind, "holiday");
  const removed = await tools.execute({ id: "call_remove_holiday", toolName: "calendar", input: { action: "remove", id: (added.output as { id: number }).id } });
  assert.equal(removed.ok, true);
  assert.deepEqual(store.listEntries(), []);
});

test("calendar tool adds and removes gregorian reminder", async () => {
  const store = createCalendarStore(dbPath("calendar-reminder"));
  const tools = createCalendarTools({
    calendarStore: store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-22T00:00:00.000Z"))
  });

  const added = await tools.execute({
    id: "call_add_reminder",
    toolName: "calendar",
    input: { action: "add", type: "reminder", calendarSystem: "gregorian", title: "ping", month: 6, day: 22, time: "00:01", isLeapMonth: true }
  });

  assert.equal(added.ok, true);
  assert.equal((added.output as { time: string }).time, "00:01");
  assert.equal((added.output as { isLeapMonth: boolean }).isLeapMonth, false);
  const removed = await tools.execute({ id: "call_remove_reminder", toolName: "calendar", input: { action: "remove", id: (added.output as { id: number }).id } });
  assert.equal(removed.ok, true);
  assert.deepEqual(store.listEntries(), []);
});

test("calendar due reminder uses short local-time window and marks one fired", () => {
  let now = new Date("2026-06-22T00:00:00.000Z");
  const store = createCalendarStore(dbPath("calendar-due-window"));
  store.addEntry({
    kind: "reminder",
    title: "ping",
    calendarSystem: "gregorian",
    month: 6,
    day: 22,
    time: "00:01",
    now: "2026-06-22T00:00:00.000",
    nowUtc: "2026-06-22T00:00:00.000Z"
  });
  const runtime = createCalendarEventRuntime({
    calendarStore: store,
    time: createCurrentTimeProvider("UTC", () => now),
    getDefaultTarget: () => ({ plugin: "test", sessionId: "session-1" })
  });

  assert.equal(runtime.consumeDueReminderEvent(), undefined);
  now = new Date("2026-06-22T00:01:00.000Z");
  const event = runtime.consumeDueReminderEvent();

  assert.equal(event?.meta.raw.calendarReminder, true);
  assert.equal(event?.meta.raw.agentInitiatedBehaviorId, "calendar_reminder");
  assert.equal(store.listEntries("reminder")[0].firedAt, "2026-06-22T00:01:00.000");
  assert.equal(runtime.consumeDueReminderEvent(), undefined);
});

test("calendar first scan after restart does not backfill old reminders", () => {
  const store = createCalendarStore(dbPath("calendar-no-backfill"));
  store.addEntry({
    kind: "reminder",
    title: "old",
    calendarSystem: "gregorian",
    month: 6,
    day: 22,
    time: "00:01",
    now: "2026-06-22T00:00:00.000",
    nowUtc: "2026-06-22T00:00:00.000Z"
  });
  const runtime = createCalendarEventRuntime({
    calendarStore: store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-22T00:05:00.000Z")),
    getDefaultTarget: () => ({ plugin: "test", sessionId: "session-1" })
  });

  assert.equal(runtime.consumeDueReminderEvent(), undefined);
  assert.equal(store.listEntries("reminder")[0].firedAt, undefined);
});

test("calendar fired reminder is not emitted after restart", () => {
  const store = createCalendarStore(dbPath("calendar-fired-restart"));
  store.addEntry({
    kind: "reminder",
    title: "done",
    calendarSystem: "gregorian",
    month: 6,
    day: 22,
    time: "00:01",
    now: "2026-06-22T00:00:00.000",
    nowUtc: "2026-06-22T00:00:00.000Z"
  });
  store.consumeDueReminder({
    dates: [{ calendarSystem: "gregorian", year: 2026, month: 6, day: 22, isLeapMonth: false, time: "00:01" }],
    firedAt: "2026-06-22T00:01:00.000",
    firedAtUtc: "2026-06-22T00:01:00.000Z"
  });
  const runtime = createCalendarEventRuntime({
    calendarStore: store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-22T00:02:00.000Z")),
    getDefaultTarget: () => ({ plugin: "test", sessionId: "session-1" })
  });

  assert.equal(runtime.consumeDueReminderEvent(), undefined);
});

test("calendar lunar reminder matches scan-time Intl lunar date", () => {
  let now = new Date("2025-07-24T14:59:00.000Z");
  const store = createCalendarStore(dbPath("calendar-lunar"));
  store.addEntry({
    kind: "reminder",
    title: "lunar",
    calendarSystem: "lunar",
    year: 2025,
    month: 6,
    day: 1,
    isLeapMonth: true,
    time: "00:00",
    now: "2025-07-24T23:59:00.000",
    nowUtc: "2025-07-24T14:59:00.000Z"
  });
  const runtime = createCalendarEventRuntime({
    calendarStore: store,
    time: createCurrentTimeProvider("Asia/Tokyo", () => now),
    getDefaultTarget: () => ({ plugin: "test", sessionId: "session-1" })
  });

  assert.equal(runtime.consumeDueReminderEvent(), undefined);
  now = new Date("2025-07-24T15:00:00.000Z");
  assert.equal(runtime.consumeDueReminderEvent()?.meta.raw.calendarReminderId, 1);
});

test("calendar context renders 11 days of structured calendar text", () => {
  const store = createCalendarStore(dbPath("calendar-context"));
  const now = "2026-06-22T08:00:00.000";
  const nowUtc = "2026-06-22T00:00:00.000Z";
  store.addEntry({ kind: "holiday", title: "端午", calendarSystem: "gregorian", month: 6, day: 22, now, nowUtc });
  store.addEntry({ kind: "birthday", title: "birthday", calendarSystem: "gregorian", month: 6, day: 22, now, nowUtc });
  store.addEntry({ kind: "reminder", title: "买药", calendarSystem: "gregorian", month: 6, day: 22, time: "09:30", now, nowUtc });

  const text = buildCalendarContext({
    calendarStore: store,
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-06-22T00:00:00.000Z")),
    userName: "Y"
  });

  assert.match(text, /^<calendar>\n/);
  assert.match(text, /\n<\/calendar>$/);
  assert.equal(text.split("\n").filter((line) => /^\d{4}-\d{2}-\d{2}/.test(line)).length, 11);
  assert.match(text, /2026-06-17 星期三 前5天\n无日程/);
  assert.match(text, /2026-06-22 星期一 今天\n端午\nY 的生日\n09:30 买药/);
  assert.doesNotMatch(text, /节日：|生日：|提醒：/);
});

function dbPath(name: string): string {
  fs.mkdirSync(path.join(process.cwd(), ".tmp-tests"), { recursive: true });
  const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-tests", `${name}-`));
  return path.join(root, "alice.sqlite");
}
