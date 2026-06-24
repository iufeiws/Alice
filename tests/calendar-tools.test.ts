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

test("calendar tool adds schedule and returns that day", async () => {
  const store = createCalendarStore(dbPath("calendar-schedule-add"));
  const tools = createCalendarTools({
    calendarStore: store,
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-06-22T00:00:00.000Z"))
  });

  const added = await tools.execute({
    id: "call_add_schedule",
    toolName: "calendar",
    input: { action: "add", title: "买药", datetime: "2026-06-23 09:30", note: "带医保卡" }
  });

  assert.equal(added.ok, true);
  assert.equal(store.listEntries("schedule")[0].title, "买药");
  assert.match((added.output as { calendar: string }).calendar, /2026-06-23 星期二 1天后\n09:30 买药 带医保卡/);
});

test("calendar store persists entry source", () => {
  const store = createCalendarStore(dbPath("calendar-source"));
  const entry = store.addEntry({
    kind: "holiday",
    title: "Christmas Day",
    source: "date-holidays:US:2026",
    meta: "{\"type\":\"public\",\"substitute\":false}",
    calendarSystem: "gregorian",
    year: 2026,
    month: 12,
    day: 25,
    now: "2026-06-22T00:00:00.000",
    nowUtc: "2026-06-22T00:00:00.000Z"
  });

  assert.equal(entry.source, "date-holidays:US:2026");
  assert.equal(entry.meta, "{\"type\":\"public\",\"substitute\":false}");
  assert.equal(store.listEntries("holiday")[0].source, "date-holidays:US:2026");
});

test("calendar tool removes schedule by title and datetime", async () => {
  const store = createCalendarStore(dbPath("calendar-schedule-remove"));
  const tools = createCalendarTools({
    calendarStore: store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-22T00:00:00.000Z"))
  });
  store.addEntry({
    kind: "schedule",
    title: "ping",
    calendarSystem: "gregorian",
    year: 2026,
    month: 6,
    day: 22,
    time: "00:01",
    now: "2026-06-22T00:00:00.000",
    nowUtc: "2026-06-22T00:00:00.000Z"
  });

  const removed = await tools.execute({
    id: "call_remove_schedule",
    toolName: "calendar",
    input: { action: "remove", title: "ping", datetime: "2026-06-22 00:01" }
  });

  assert.equal(removed.ok, true);
  assert.equal((removed.output as { removed: { title: string } }).removed.title, "ping");
  assert.deepEqual(store.listEntries(), []);
});

test("calendar tool tolerates one unique remove field and returns candidates on miss", async () => {
  const store = createCalendarStore(dbPath("calendar-schedule-remove-candidates"));
  const tools = createCalendarTools({
    calendarStore: store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-22T00:00:00.000Z"))
  });
  for (const entry of [
    { title: "牙医", day: 23, time: "09:00" },
    { title: "体检", day: 24, time: "10:00" },
    { title: "体检", day: 25, time: "11:00" }
  ]) {
    store.addEntry({
      kind: "schedule",
      title: entry.title,
      calendarSystem: "gregorian",
      year: 2026,
      month: 6,
      day: entry.day,
      time: entry.time,
      now: "2026-06-22T00:00:00.000",
      nowUtc: "2026-06-22T00:00:00.000Z"
    });
  }

  const tolerant = await tools.execute({
    id: "call_remove_tolerant",
    toolName: "calendar",
    input: { action: "remove", title: "错误标题", datetime: "2026-06-23 09:00" }
  });
  assert.equal(tolerant.ok, true);
  assert.equal((tolerant.output as { removed: { title: string } }).removed.title, "牙医");

  const missed = await tools.execute({
    id: "call_remove_missed",
    toolName: "calendar",
    input: { action: "remove", title: "体检", datetime: "2026-06-26 12:00" }
  });
  assert.equal(missed.ok, false);
  assert.deepEqual((missed.output as { titleMatches: Array<{ datetime: string }> }).titleMatches.map((entry) => entry.datetime), ["2026-06-25 11:00", "2026-06-24 10:00"]);
});

test("calendar tool searches future schedules", async () => {
  const store = createCalendarStore(dbPath("calendar-search"));
  const tools = createCalendarTools({
    calendarStore: store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-22T00:00:00.000Z"))
  });
  store.addEntry({ kind: "schedule", title: "买药", note: "医保卡", calendarSystem: "gregorian", year: 2026, month: 6, day: 23, time: "09:30", now: "2026-06-22T00:00:00.000", nowUtc: "2026-06-22T00:00:00.000Z" });
  store.addEntry({ kind: "schedule", title: "旧事项", calendarSystem: "gregorian", year: 2026, month: 6, day: 21, now: "2026-06-22T00:00:00.000", nowUtc: "2026-06-22T00:00:00.000Z" });

  const result = await tools.execute({
    id: "call_search_calendar",
    toolName: "calendar",
    input: { action: "search", searchkey: ["医保", "09:30"] }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.output, [{ title: "买药", datetime: "2026-06-23 09:30", note: "医保卡" }]);
});

test("calendar tool lists calendar range with empty days", async () => {
  const store = createCalendarStore(dbPath("calendar-list"));
  const tools = createCalendarTools({
    calendarStore: store,
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-06-22T00:00:00.000Z"))
  });
  store.addEntry({
    kind: "holiday",
    title: "端午",
    calendarSystem: "gregorian",
    month: 6,
    day: 22,
    now: "2026-06-22T08:00:00.000",
    nowUtc: "2026-06-22T00:00:00.000Z"
  });

  const listed = await tools.execute({
    id: "call_list_calendar",
    toolName: "calendar",
    input: { action: "list", daysBefore: 1, daysAfter: 1 }
  });

  assert.equal(listed.ok, true);
  assert.equal(listed.output, [
    "<calendar>",
    "2026-06-21 星期日 1天前",
    "-空-",
    "",
    "2026-06-22 星期一 今天",
    "端午",
    "",
    "2026-06-23 星期二 1天后",
    "-空-",
    "</calendar>"
  ].join("\n"));
});

test("calendar due reminder uses short local-time window and marks one fired", () => {
  let now = new Date("2026-06-22T00:00:00.000Z");
  const store = createCalendarStore(dbPath("calendar-due-window"));
  store.addEntry({
    kind: "schedule",
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
  assert.equal(store.listEntries("schedule")[0].firedAt, "2026-06-22T00:01:00.000");
  assert.equal(runtime.consumeDueReminderEvent(), undefined);
});

test("calendar first scan after restart does not backfill old reminders", () => {
  const store = createCalendarStore(dbPath("calendar-no-backfill"));
  store.addEntry({
    kind: "schedule",
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
  assert.equal(store.listEntries("schedule")[0].firedAt, undefined);
});

test("calendar fired reminder is not emitted after restart", () => {
  const store = createCalendarStore(dbPath("calendar-fired-restart"));
  store.addEntry({
    kind: "schedule",
    title: "done",
    calendarSystem: "gregorian",
    month: 6,
    day: 22,
    time: "00:01",
    now: "2026-06-22T00:00:00.000",
    nowUtc: "2026-06-22T00:00:00.000Z"
  });
  store.consumeDueSchedule({
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
    kind: "schedule",
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

test("calendar context renders only days with calendar entries", () => {
  const store = createCalendarStore(dbPath("calendar-context"));
  const now = "2026-06-22T08:00:00.000";
  const nowUtc = "2026-06-22T00:00:00.000Z";
  store.addEntry({ kind: "holiday", title: "端午", calendarSystem: "gregorian", month: 6, day: 22, now, nowUtc });
  store.addEntry({ kind: "holiday", title: "过去节日", calendarSystem: "gregorian", month: 6, day: 17, now, nowUtc });
  store.addEntry({ kind: "holiday", title: "未来节日", calendarSystem: "gregorian", month: 6, day: 27, meta: "{\"type\":\"public\"}", now, nowUtc });
  store.addEntry({ kind: "birthday", title: "birthday", calendarSystem: "gregorian", month: 6, day: 22, now, nowUtc });
  store.addEntry({ kind: "schedule", title: "买药", calendarSystem: "gregorian", month: 6, day: 22, time: "09:30", now, nowUtc });

  const text = buildCalendarContext({
    calendarStore: store,
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-06-22T00:00:00.000Z")),
    userName: "Y"
  });

  assert.match(text, /^<calendar>\n/);
  assert.match(text, /\n<\/calendar>$/);
  assert.equal(text.split("\n").filter((line) => /^\d{4}-\d{2}-\d{2}/.test(line)).length, 3);
  assert.doesNotMatch(text, /无日程/);
  assert.match(text, /2026-06-17 星期三 5天前\n过去节日/);
  assert.match(text, /2026-06-22 星期一 今天\n端午\nY 的生日\n09:30 买药/);
  assert.match(text, /2026-06-27 星期六 5天后\n未来节日/);
  assert.doesNotMatch(text, /public/);
  assert.doesNotMatch(text, /节日：|生日：|提醒：/);
});

function dbPath(name: string): string {
  fs.mkdirSync(path.join(process.cwd(), ".tmp-tests"), { recursive: true });
  const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-tests", `${name}-`));
  return path.join(root, "alice.sqlite");
}
