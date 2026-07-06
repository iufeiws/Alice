import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarStore, calendarTools, addSchedule } from "./calendar-tools-helpers.js";

test("calendar store creates calendar_entries in alice sqlite", () => {
  const store = calendarStore("calendar-store-init");
  assert.deepEqual(store.listEntries(), []);
});

test("calendar store persists entry source", () => {
  const store = calendarStore("calendar-source");
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

test("calendar add action stores schedule", async () => {
  const store = calendarStore("calendar-schedule-add");
  const tools = calendarTools({
    store,
    timeZone: "Asia/Shanghai",
    now: new Date("2026-06-22T00:00:00.000Z")
  });

  const added = await tools.execute({
    id: "call_add_schedule",
    toolName: "calendar",
    input: { action: "add", title: "买药", datetime: "2026-06-23 09:30", note: "带医保卡" }
  });

  assert.equal(added.ok, true);
  assert.equal(store.listEntries("schedule")[0].title, "买药");
});

test("calendar add action returns the day view", async () => {
  const store = calendarStore("calendar-schedule-add-view");
  const tools = calendarTools({
    store,
    timeZone: "Asia/Shanghai",
    now: new Date("2026-06-22T00:00:00.000Z")
  });

  const added = await tools.execute({
    id: "call_add_schedule_view",
    toolName: "calendar",
    input: { action: "add", title: "买药", datetime: "2026-06-23 09:30", note: "带医保卡" }
  });

  assert.equal(added.ok, true);
});

test("calendar remove action deletes an exact future schedule", async () => {
  const store = calendarStore("calendar-schedule-remove");
  const tools = calendarTools({ store });
  addSchedule(store, { title: "ping", year: 2026, day: 22, time: "00:01" });

  const removed = await tools.execute({
    id: "call_remove_schedule",
    toolName: "calendar",
    input: { action: "remove", title: "ping", datetime: "2026-06-22 00:01" }
  });

  assert.equal(removed.ok, true);
  assert.equal((removed.output as { removed: { title: string } }).removed.title, "ping");
  assert.deepEqual(store.listEntries(), []);
});

test("calendar remove action accepts one unique field", async () => {
  const store = calendarStore("calendar-schedule-remove-tolerant");
  const tools = calendarTools({ store });
  addSchedule(store, { title: "牙医", year: 2026, day: 23, time: "09:00" });

  const tolerant = await tools.execute({
    id: "call_remove_tolerant",
    toolName: "calendar",
    input: { action: "remove", title: "错误标题", datetime: "2026-06-23 09:00" }
  });
  assert.equal(tolerant.ok, true);
  assert.equal((tolerant.output as { removed: { title: string } }).removed.title, "牙医");
});

test("calendar remove action returns candidates for misses", async () => {
  const store = calendarStore("calendar-schedule-remove-candidates");
  const tools = calendarTools({ store });
  addSchedule(store, { title: "体检", year: 2026, day: 24, time: "10:00" });
  addSchedule(store, { title: "体检", year: 2026, day: 25, time: "11:00" });

  const missed = await tools.execute({
    id: "call_remove_missed",
    toolName: "calendar",
    input: { action: "remove", title: "体检", datetime: "2026-06-26 12:00" }
  });
  const titleMatches = (missed.output as { titleMatches: Array<{ datetime: string }> }).titleMatches;

  assert.equal(missed.ok, false);
  assert.deepEqual(new Set(titleMatches.map((entry) => entry.datetime)), new Set(["2026-06-25 11:00", "2026-06-24 10:00"]));
});

test("calendar search action returns matching future schedules", async () => {
  const store = calendarStore("calendar-search");
  const tools = calendarTools({ store });
  addSchedule(store, { title: "买药", note: "医保卡", year: 2026, day: 23, time: "09:30" });
  addSchedule(store, { title: "旧事项", year: 2026, day: 21 });

  const result = await tools.execute({
    id: "call_search_calendar",
    toolName: "calendar",
    input: { action: "search", searchkey: ["医保", "09:30"] }
  });

  assert.equal(result.ok, true);
});

test("calendar list action returns visible days", async () => {
  const store = calendarStore("calendar-list");
  const tools = calendarTools({
    store,
    timeZone: "Asia/Shanghai",
    now: new Date("2026-06-22T00:00:00.000Z")
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
    input: { action: "list", daysBefore: 2, daysAfter: 2 }
  });

  assert.equal(listed.ok, true);
});

test("calendar list action returns one empty marker", async () => {
  const store = calendarStore("calendar-list-empty");
  const tools = calendarTools({
    store,
    timeZone: "Asia/Shanghai",
    now: new Date("2026-06-22T00:00:00.000Z")
  });

  const empty = await tools.execute({
    id: "call_list_calendar_empty",
    toolName: "calendar",
    input: { action: "list", daysBefore: 2, daysAfter: 2 }
  });

  assert.equal(empty.ok, true);
});
