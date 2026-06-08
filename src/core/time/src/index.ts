export type CurrentTimeRecord = {
  date: Date;
  epochMs: number;
  timeZone: string;
  iso: string;
};

export type CurrentTimeProvider = {
  timeZone: string;
  now(): CurrentTimeRecord;
  addMs(ms: number, from?: Date): CurrentTimeRecord;
};

export type MutableCurrentTimeProvider = CurrentTimeProvider & {
  setTimeZone(timeZone: string): void;
};

export function createCurrentTimeProvider(
  timeZone: string,
  now: () => Date = () => new Date()
): CurrentTimeProvider {
  return {
    timeZone,
    now() {
      return recordFor(now(), timeZone);
    },
    addMs(ms, from = now()) {
      return recordFor(new Date(from.getTime() + Math.max(0, ms)), timeZone);
    }
  };
}

export function createMutableCurrentTimeProvider(
  initialTimeZone: string,
  now: () => Date = () => new Date()
): MutableCurrentTimeProvider {
  let timeZone = initialTimeZone;
  return {
    get timeZone() {
      return timeZone;
    },
    setTimeZone(nextTimeZone) {
      timeZone = nextTimeZone;
    },
    now() {
      return recordFor(now(), timeZone);
    },
    addMs(ms, from = now()) {
      return recordFor(new Date(from.getTime() + Math.max(0, ms)), timeZone);
    }
  };
}

export function formatZonedIso(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const millis = date.getUTCMilliseconds().toString().padStart(3, "0");
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}.${millis}`;
}

export function parseZonedIso(value: string, timeZone: string): Date {
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(value)) return new Date(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value);
  if (!match) return new Date(value);
  return zonedDateTimeToDate(
    {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
      second: Number(match[6]),
      millisecond: Number((match[7] ?? "0").padEnd(3, "0"))
    },
    timeZone
  );
}

export function previousDailyAnchor(hour: number, timeZone: string, from: Date = new Date()): Date {
  const safeHour = Math.max(0, Math.min(23, Math.trunc(hour)));
  const zonedNow = zonedParts(from, timeZone);
  const anchorDate = zonedNow.hour >= safeHour
    ? { year: zonedNow.year, month: zonedNow.month, day: zonedNow.day }
    : shiftLocalDate(zonedNow.year, zonedNow.month, zonedNow.day, -1);
  return zonedDateTimeToDate(
    {
      year: anchorDate.year,
      month: anchorDate.month,
      day: anchorDate.day,
      hour: safeHour,
      minute: 0,
      second: 0
    },
    timeZone
  );
}

export function todayMessagingAnchor(timeZone: string, from: Date = new Date()): Date {
  const zonedNow = zonedParts(from, timeZone);
  const anchorDate = zonedNow.hour < 6
    ? shiftLocalDate(zonedNow.year, zonedNow.month, zonedNow.day, -1)
    : { year: zonedNow.year, month: zonedNow.month, day: zonedNow.day };
  return zonedDateTimeToDate(
    {
      year: anchorDate.year,
      month: anchorDate.month,
      day: anchorDate.day,
      hour: 0,
      minute: 0,
      second: 0
    },
    timeZone
  );
}

function recordFor(date: Date, timeZone: string): CurrentTimeRecord {
  return {
    date,
    epochMs: date.getTime(),
    timeZone,
    iso: formatZonedIso(date, timeZone)
  };
}

type ZonedDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond?: number;
};

function zonedParts(date: Date, timeZone: string): ZonedDateTimeParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function shiftLocalDate(year: number, month: number, day: number, deltaDays: number): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate()
  };
}

function zonedDateTimeToDate(target: ZonedDateTimeParts, timeZone: string): Date {
  const millisecond = target.millisecond ?? 0;
  let guess = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second, millisecond);
  for (let i = 0; i < 5; i += 1) {
    const observed = zonedParts(new Date(guess), timeZone);
    const delta = Date.UTC(
      target.year,
      target.month - 1,
      target.day,
      target.hour,
      target.minute,
      target.second
    ) - Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second
    );
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}
