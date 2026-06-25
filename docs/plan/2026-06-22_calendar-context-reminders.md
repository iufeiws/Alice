# Calendar Context And Reminder Plan

## Summary

Add a calendar context backed by `memory-files/alice.sqlite`, plus one LLM-visible `calendar` tool with `add` and `remove`. It stores day-only holidays, birthdays, and one-shot timed reminders as the same entry shape. Due reminder search calculates the current gregorian and lunar date at scan time, then aggregates matching entries. It does not add hardcoded prompt text.

## Scope

- Day-only holidays:
  - Stored as date facts without a time.
  - Support `calendarSystem: "gregorian" | "lunar"`.
  - Each entry owns its calendar system; gregorian/lunar are not separate rows for the same event.
  - Store `month`, `day`, optional `year`, optional `isLeapMonth`.
- Timed reminders:
  - One-shot only.
  - Store date fields and local `time` in Alice's configured timezone.
  - Due reminders are found by a short heartbeat scan window, not by `setTimeout`.
  - Fired timestamps are audit fields only; UTC is not part of reminder matching.
- Admin:
  - Add birthday settings directly below the existing user-name setting in the Prompt profile editor.
  - Store birthday as a calendar day fact, not as prompt text.
- Variables:
  - Move the wake-time yesterday/today/tomorrow values into `buildLLMTextVariables`.
  - Admin "变量解析树" then shows them automatically.

## Data Model

Add a calendar store that opens the existing `alice.sqlite` path. Use one table so holiday, birthday, and reminder matching goes through the same code.

```sql
CREATE TABLE IF NOT EXISTS calendar_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('holiday', 'birthday', 'reminder')),
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  calendar_system TEXT NOT NULL CHECK (calendar_system IN ('gregorian', 'lunar')),
  year INTEGER,
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  day INTEGER NOT NULL CHECK (day BETWEEN 1 AND 31),
  is_leap_month INTEGER NOT NULL DEFAULT 0,
  time TEXT,
  fired_at TEXT,
  fired_at_utc TEXT,
  created_at TEXT NOT NULL,
  created_at_utc TEXT
);

CREATE INDEX IF NOT EXISTS calendar_entries_lookup_idx
  ON calendar_entries(kind, calendar_system, month, day, time);
```

There is no `scheduled_at_utc`. `created_at_utc` is creation audit. `fired_at_utc` is firing audit. Reminder eligibility is based on Alice local time plus calendar-system date matching.

## Tool Contract

Expose one tool from `src/capabilities/tools/calendar`.

- `calendar({ action: "add", type: "holiday", ... })`
- `calendar({ action: "add", type: "reminder", ... })`
- `calendar({ action: "remove", id })`

Inputs:

- `type`: `"holiday" | "reminder"`.
- `calendarSystem`: `"gregorian" | "lunar"`.
- `title`: required.
- holiday: `month`, `day`, optional `year`, optional `isLeapMonth`.
- reminder: `month`, `day`, `time`, optional `year`, optional `isLeapMonth`, optional `note`.

Removal is by `id` only. Skipped: fuzzy remove by title/date, because it can delete the wrong thing.

## Due Reminder Flow

Add `calendarEventRuntime` next to `sleepCocoonEventRuntime`.

- Heartbeat asks `calendarEventRuntime.consumeDueReminderEvent()`.
- Runtime keeps an in-memory `lastCalendarReminderScanAt`.
- First scan after process start sets `lastCalendarReminderScanAt = now` and returns no event.
- Later scans match reminders whose local `time` is in `(lastScanAt, now]`, capped to a short window, initially 2 minutes.
- This is not a catch-up mechanism: if the process was down for the reminder time, it is not fired later.
- Runtime calculates both current gregorian date and current lunar date for the scan window.
- It queries unfired reminder entries matching either:
  - `calendar_system = 'gregorian'` and gregorian `year/month/day/time`.
  - `calendar_system = 'lunar'` and lunar `year/month/day/time/is_leap_month`.
- It aggregates matching gregorian and lunar rows.
- It marks exactly one reminder fired in the same transaction.
- It returns a generated event with raw metadata:

```json
{
  "calendarReminder": true,
  "agentInitiatedTriggerEvent": "calendar.schedule_due",
  "calendarReminderId": 1
}
```

Add an event initiated behavior plan:

- `id`: `calendar_reminder`
- `kind`: `event`
- `triggerEvent`: `calendar.schedule_due`
- `steps`: one `llm_instruction` layer profile path, created only after the prompt content is confirmed.

No tool-name/requester/channel special casing. The generated event enters the same initiated behavior execution path as the sleep events.

## Admin Birthday

Current name setting is `Prompt -> User Name`. Add birthday fields below it:

- calendar system select: gregorian / lunar
- month
- day
- optional year
- lunar leap-month checkbox

Saving writes a `calendar_entries.kind = 'birthday'` row through the calendar store. The prompt profile keeps owning `userName`; birthday is not added into prompt profile JSON.

## Variables

Extend `wakeBoundary`:

```json
{
  "wakeBoundary": {
    "occurredAt": "...",
    "occurredAtUtc": "...",
    "date": "2026-06-22",
    "weekday": "星期一",
    "yesterday": {
      "date": "2026-06-21",
      "weekday": "星期日"
    },
    "today": {
      "date": "2026-06-22",
      "weekday": "星期一"
    },
    "tomorrow": {
      "date": "2026-06-23",
      "weekday": "星期二"
    }
  }
}
```

This only changes variable data. Existing prompt layers must opt in by referencing the variables; no prompt content is appended by code.

## Tests

- Calendar store creates `calendar_entries` in `alice.sqlite`.
- Add/remove holiday.
- Add/remove gregorian reminder.
- Due reminder uses the short `(lastScanAt, now]` local-time window.
- First scan after restart does not backfill old reminders.
- Due reminder marks one reminder fired and emits one generated event.
- Fired reminder is not emitted again after restart.
- Lunar reminder is matched by scan-time lunar date calculation, not converted at write time.
- Admin birthday save writes `calendar_entries.kind = 'birthday'`.
- `buildLLMTextVariables` exposes `wakeBoundary.yesterday/today/tomorrow`.

## Confirm Before Implementation

- What exact initiated behavior prompt should `calendar_reminder` use.
- Whether birthday should be visible to normal chat variables immediately, or only in admin/calendar tools first.
- Which lunar date implementation to use for scan-time gregorian-to-lunar calculation.
