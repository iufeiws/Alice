import type { CurrentTimeProvider } from "../../../../shared/clock/src/index.js";
import { formatZonedIso } from "../../../../platform/time/src/index.js";
import { createId } from "../../../../shared/uuid/src/index.js";
import type { CalendarDueDate, CalendarStore } from "../../../../platform/storage/src/calendar-store.js";
import type { MessagingToolTarget } from "../../messaging/src/index.js";

const scanWindowMs = 2 * 60 * 1000;

export function createCalendarEventRuntime(input: {
  calendarStore: CalendarStore;
  time: CurrentTimeProvider;
  getDefaultTarget(): MessagingToolTarget | undefined;
}) {
  let lastCalendarReminderScanAt: number | undefined;

  return {
    consumeDueReminderEvent
  };

  function consumeDueReminderEvent() {
    const now = input.time.now();
    if (lastCalendarReminderScanAt === undefined) {
      lastCalendarReminderScanAt = now.epochMs;
      return undefined;
    }
    const fromExclusive = Math.max(lastCalendarReminderScanAt, now.epochMs - scanWindowMs);
    lastCalendarReminderScanAt = now.epochMs;
    const target = input.getDefaultTarget();
    if (!target) return undefined;
    const dates = dueDatesInWindow(fromExclusive, now.epochMs, input.time.timeZone);
    const reminder = input.calendarStore.consumeDueSchedule({
      dates,
      firedAt: now.iso,
      firedAtUtc: now.date.toISOString()
    });
    if (!reminder) return undefined;
    return {
      id: createId("calendar_reminder"),
      source: {
        plugin: target.plugin,
        accountId: target.accountId,
        channelId: target.channelId,
        userId: target.userId
      },
      externalSession: {
        scope: "dm" as const,
        sessionId: target.sessionId
      },
      type: "system.heartbeat" as const,
      payload: {
        kind: "text" as const,
        text: ""
      },
      meta: {
        receivedAt: now.iso,
        receivedAtUtc: now.date.toISOString(),
        raw: {
          calendarReminder: true,
          agentInitiatedBehaviorId: "calendar_reminder",
          calendarReminderId: reminder.id
        }
      }
    };
  }
}

export function dueDatesInWindow(fromExclusiveMs: number, toInclusiveMs: number, timeZone: string): CalendarDueDate[] {
  const dates = new Map<string, CalendarDueDate>();
  for (let instantMs = Math.ceil((fromExclusiveMs + 1) / 60_000) * 60_000; instantMs <= toInclusiveMs; instantMs += 60_000) {
    for (const date of calendarDatesAt(new Date(instantMs), timeZone)) {
      dates.set(`${date.calendarSystem}:${date.year}:${date.month}:${date.day}:${date.isLeapMonth ? 1 : 0}:${date.time}`, date);
    }
  }
  return [...dates.values()];
}

export function calendarDatesAt(date: Date, timeZone: string): CalendarDueDate[] {
  const local = formatZonedIso(date, timeZone);
  const time = local.slice(11, 16);
  const gregorian = {
    calendarSystem: "gregorian" as const,
    year: Number(local.slice(0, 4)),
    month: Number(local.slice(5, 7)),
    day: Number(local.slice(8, 10)),
    isLeapMonth: false,
    time
  };
  return [gregorian, { ...lunarDateAt(date, timeZone), time }];
}

function lunarDateAt(date: Date, timeZone: string): Omit<CalendarDueDate, "time"> {
  const parts = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", {
    timeZone,
    year: "numeric",
    month: "long",
    day: "numeric"
  }).formatToParts(date);
  const monthText = part(parts, "month");
  return {
    calendarSystem: "lunar",
    year: Number(part(parts, "relatedYear")),
    month: chineseMonthNumber(monthText),
    day: Number(part(parts, "day")),
    isLeapMonth: monthText.startsWith("闰")
  };
}

function part(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find((entry) => entry.type === type)?.value ?? "";
}

function chineseMonthNumber(value: string): number {
  const text = value.replace(/^闰/, "").replace(/月$/, "");
  const names: Record<string, number> = {
    正: 1,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
    十一: 11,
    十二: 12
  };
  return names[text] ?? Number(text);
}
