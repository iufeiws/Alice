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
