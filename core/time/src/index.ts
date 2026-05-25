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
  if (timeZone === "UTC") return date.toISOString();

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const offset = normalizeOffset(values.timeZoneName);
  const millis = date.getUTCMilliseconds().toString().padStart(3, "0");
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}.${millis}${offset}`;
}

function recordFor(date: Date, timeZone: string): CurrentTimeRecord {
  return {
    date,
    epochMs: date.getTime(),
    timeZone,
    iso: formatZonedIso(date, timeZone)
  };
}

function normalizeOffset(value: string | undefined): string {
  if (!value || value === "GMT") return "Z";
  const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(value);
  if (!match) return "Z";
  return `${match[1]}${match[2].padStart(2, "0")}:${match[3] ?? "00"}`;
}
