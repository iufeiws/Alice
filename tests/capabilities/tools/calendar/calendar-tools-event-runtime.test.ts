import { test } from "node:test";
import assert from "node:assert/strict";
import { createCurrentTimeProvider } from "../../../../src/platform/time/src/index.js";
import { createCalendarEventRuntime } from "../../../../src/capabilities/tools/calendar/src/index.js";
import { calendarStore, addSchedule } from "./calendar-tools-helpers.js";

function dueReminderRuntime() {
  let now = new Date("2026-06-22T00:00:00.000Z");
  const store = calendarStore("calendar-due-window");
  addSchedule(store, { title: "ping", day: 22, time: "00:01" });
  const runtime = createCalendarEventRuntime({
    calendarStore: store,
    time: createCurrentTimeProvider("UTC", () => now),
    getDefaultTarget: () => ({ plugin: "test", sessionId: "session-1" })
  });

  return {
    runtime,
    store,
    advanceToDue() {
      now = new Date("2026-06-22T00:01:00.000Z");
    }
  };
}

test("calendar due reminder is not emitted before the due window", () => {
  const { runtime } = dueReminderRuntime();

  assert.equal(runtime.consumeDueReminderEvent(), undefined);
});

test("calendar due reminder emits an agent trigger at the due time", () => {
  const { runtime, advanceToDue } = dueReminderRuntime();
  runtime.consumeDueReminderEvent();
  advanceToDue();

  const event = runtime.consumeDueReminderEvent();

  assert.equal(event?.meta.raw.calendarReminder, true);
  assert.equal(event?.meta.raw.agentInitiatedTriggerEvent, "calendar.schedule_due");
});

test("calendar due reminder marks the schedule fired", () => {
  const { runtime, store, advanceToDue } = dueReminderRuntime();
  runtime.consumeDueReminderEvent();
  advanceToDue();

  runtime.consumeDueReminderEvent();

  assert.equal(store.listEntries("schedule")[0].firedAt, "2026-06-22T00:01:00.000");
});

test("calendar due reminder is emitted once", () => {
  const { runtime, advanceToDue } = dueReminderRuntime();
  runtime.consumeDueReminderEvent();
  advanceToDue();

  assert.ok(runtime.consumeDueReminderEvent());

  assert.equal(runtime.consumeDueReminderEvent(), undefined);
});

test("calendar first scan after restart does not backfill old reminders", () => {
  const store = calendarStore("calendar-no-backfill");
  addSchedule(store, { title: "old", day: 22, time: "00:01" });
  const runtime = createCalendarEventRuntime({
    calendarStore: store,
    time: createCurrentTimeProvider("UTC", () => new Date("2026-06-22T00:05:00.000Z")),
    getDefaultTarget: () => ({ plugin: "test", sessionId: "session-1" })
  });

  assert.equal(runtime.consumeDueReminderEvent(), undefined);
  assert.equal(store.listEntries("schedule")[0].firedAt, undefined);
});

test("calendar fired reminder is not emitted after restart", () => {
  const store = calendarStore("calendar-fired-restart");
  addSchedule(store, { title: "done", day: 22, time: "00:01" });
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
  const store = calendarStore("calendar-lunar");
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
