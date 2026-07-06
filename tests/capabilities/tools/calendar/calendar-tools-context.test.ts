import { test } from "node:test";
import assert from "node:assert/strict";
import { createCurrentTimeProvider } from "../../../../src/platform/time/src/index.js";
import { buildCalendarContext } from "../../../../src/capabilities/tools/calendar/src/index.js";
import { calendarStore, addSchedule } from "./calendar-tools-helpers.js";

function renderCalendarContext() {
  const store = calendarStore("calendar-context");
  const now = "2026-06-22T08:00:00.000";
  const nowUtc = "2026-06-22T00:00:00.000Z";
  store.addEntry({ kind: "holiday", title: "端午", calendarSystem: "gregorian", month: 6, day: 22, now, nowUtc });
  store.addEntry({ kind: "holiday", title: "过去节日", calendarSystem: "gregorian", month: 6, day: 17, now, nowUtc });
  store.addEntry({ kind: "holiday", title: "未来节日", calendarSystem: "gregorian", month: 6, day: 27, meta: "{\"type\":\"public\"}", now, nowUtc });
  store.addEntry({ kind: "birthday", title: "birthday", calendarSystem: "gregorian", month: 6, day: 22, now, nowUtc });
  addSchedule(store, { title: "买药", day: 22, time: "09:30" });

  return buildCalendarContext({
    calendarStore: store,
    time: createCurrentTimeProvider("Asia/Shanghai", () => new Date("2026-06-22T00:00:00.000Z")),
    userName: "Y"
  });
}

test("calendar context only renders days with entries", () => {
  const text = renderCalendarContext();

  assert.equal(text.split("\n").filter((line) => /^\d{4}-\d{2}-\d{2}/.test(line)).length, 3);
});
