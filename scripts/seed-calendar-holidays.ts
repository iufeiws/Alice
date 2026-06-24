import Holidays from "date-holidays";
import type { HolidaysTypes } from "date-holidays";
import { loadConfig } from "../src/apps/api/bootstrap/app-config-runtime.js";
import { formatZonedIso } from "../src/platform/time/src/index.js";
import { createCalendarStore, type CalendarStore } from "../src/platform/storage/src/calendar-store.js";

const fs = await import("node:fs");
const path = await import("node:path");

type Args = {
  countries: string[];
  years?: number[];
  dbPath?: string;
};

loadDotEnv(".env");

const config = loadConfig();
const args = parseArgs(process.argv.slice(2));
const years = args.years ?? currentAndNextYear(config.core.timezone);
const dbPath = args.dbPath ?? path.join(config.memoryFiles.root, "alice.sqlite");
const store = createCalendarStore(dbPath);
const migrated = migrateDateHolidayNotes(store);
let added = 0;
let skipped = 0;

for (const country of args.countries) {
  for (const year of years) {
    const result = seedCountryYear(store, country, year);
    added += result.added;
    skipped += result.skipped;
  }
}

console.log(`seeded calendar holidays: added=${added} skipped=${skipped} migrated=${migrated} db=${dbPath}`);

function seedCountryYear(store: CalendarStore, country: string, year: number): { added: number; skipped: number } {
  const countryCode = country.trim().toUpperCase();
  const holidays = new Holidays(countryCode).getHolidays(year);
  const existing = store.listEntries("holiday");
  const seen = new Set(existing.map((entry) => holidayKey(entry.source, entry.title, entry.year, entry.month, entry.day)));
  const now = new Date();
  const nowIso = formatZonedIso(now, config.core.timezone);
  const source = `date-holidays:${countryCode}:${year}`;
  let added = 0;
  let skipped = 0;

  for (const holiday of holidays) {
    const localDate = datePart(holiday);
    const key = holidayKey(source, holiday.name, Number(localDate.slice(0, 4)), Number(localDate.slice(5, 7)), Number(localDate.slice(8, 10)));
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    store.addEntry({
      kind: "holiday",
      title: holiday.name,
      source,
      meta: holidayMeta(holiday),
      calendarSystem: "gregorian",
      year: Number(localDate.slice(0, 4)),
      month: Number(localDate.slice(5, 7)),
      day: Number(localDate.slice(8, 10)),
      now: nowIso,
      nowUtc: now.toISOString()
    });
    added += 1;
  }

  return { added, skipped };
}

function parseArgs(values: string[]): Args {
  const args: Args = { countries: ["CN"] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--countries") args.countries = splitList(requiredValue(values, ++index, value)).map((entry) => entry.toUpperCase());
    else if (value === "--years") args.years = splitList(requiredValue(values, ++index, value)).map(numberValue);
    else if (value === "--db") args.dbPath = requiredValue(values, ++index, value);
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

function splitList(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function requiredValue(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (!value) throw new Error(`Missing value for ${flag}`);
  return value;
}

function numberValue(value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 9999) throw new Error(`Invalid year: ${value}`);
  return number;
}

function currentAndNextYear(timeZone: string): number[] {
  const year = Number(new Intl.DateTimeFormat("en", { timeZone, year: "numeric" }).format(new Date()));
  return [year, year + 1];
}

function datePart(holiday: HolidaysTypes.Holiday): string {
  return holiday.date.slice(0, 10);
}

function holidayMeta(holiday: HolidaysTypes.Holiday): string {
  return JSON.stringify({
    type: holiday.type,
    substitute: holiday.substitute === true
  });
}

function holidayKey(source: string, title: string, year: number | undefined, month: number, day: number): string {
  return `${source}\0${title}\0${year ?? ""}\0${month}\0${day}`;
}

function migrateDateHolidayNotes(store: CalendarStore): number {
  let migrated = 0;
  for (const entry of store.listEntries("holiday")) {
    if (!entry.source.startsWith("date-holidays:") || !isDateHolidayTypeNote(entry.note)) continue;
    store.updateEntryDetails({
      id: entry.id,
      note: "",
      meta: entry.meta || JSON.stringify({ type: entry.note, substitute: false })
    });
    migrated += 1;
  }
  return migrated;
}

function isDateHolidayTypeNote(value: string): boolean {
  return /^(public|bank|optional|school|observance)( substitute)?$/.test(value);
}

function loadDotEnv(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = unquoteEnvValue(rawValue);
  }
}

function unquoteEnvValue(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
