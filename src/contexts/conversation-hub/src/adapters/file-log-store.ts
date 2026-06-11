const fs = await import("node:fs");
const path = await import("node:path");

export type FileSystemLogEntry = {
  id: number;
  time: string;
  utcTime?: string;
  level: "info" | "warn" | "error";
  message: string;
};

export type FileLogStore = {
  append(input: Omit<FileSystemLogEntry, "id">): FileSystemLogEntry;
  listRecent(limit: number): FileSystemLogEntry[];
  cleanupOlderThan(retentionDays: number, now?: Date): number;
};

export function createFileLogStore(root: string, options: { timeZone?: string; getTimeZone?: () => string | undefined } = {}): FileLogStore {
  fs.mkdirSync(root, { recursive: true });
  let nextId = nextIdFromLatestLogFile(root);
  const getTimeZone = options.getTimeZone ?? (() => options.timeZone);

  return {
    append(input) {
      const entry: FileSystemLogEntry = {
        id: nextId,
        ...input
      };
      nextId += 1;

      fs.appendFileSync(logPathFor(root, input.utcTime ?? input.time, getTimeZone()), `${JSON.stringify(entry)}\n`);
      return entry;
    },
    listRecent(limit) {
      return readRecent(root, limit);
    },
    cleanupOlderThan(retentionDays, now = new Date()) {
      const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
      let removed = 0;
      for (const file of fs.readdirSync(root)) {
        if (!file.endsWith(".log.jsonl")) continue;
        const date = file.slice(0, "YYYY-MM-DD".length);
        if (date < toLocalDate(cutoff, getTimeZone())) {
          fs.rmSync(path.join(root, file));
          removed += 1;
        }
      }
      return removed;
    }
  };
}

function nextIdFromLatestLogFile(root: string): number {
  const file = logFiles(root).at(-1);
  if (!file) return 1;
  let nextId = 1;
  for (const entry of readFileEntries(path.join(root, file))) {
    nextId = Math.max(nextId, entry.id + 1);
  }
  return nextId;
}

function readRecent(root: string, limit: number): FileSystemLogEntry[] {
  if (limit <= 0) return [];
  const entries: FileSystemLogEntry[] = [];
  for (const file of logFiles(root).reverse()) {
    const fileEntries = readFileEntries(path.join(root, file));
    entries.unshift(...fileEntries.slice(-Math.max(0, limit - entries.length)));
    if (entries.length >= limit) return entries.slice(-limit);
  }
  return entries.slice(-limit);
}

function logFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((item) => item.endsWith(".log.jsonl")).sort();
}

function readFileEntries(filePath: string): FileSystemLogEntry[] {
  const entries: FileSystemLogEntry[] = [];
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as FileSystemLogEntry);
    } catch {
      // Ignore malformed debug lines.
    }
  }
  return entries;
}

function logPathFor(root: string, isoTime: string, timeZone?: string): string {
  return path.join(root, `${toLocalDate(new Date(isoTime), timeZone)}.log.jsonl`);
}

function toLocalDate(date: Date, timeZone?: string): string {
  if (!timeZone) return date.toISOString().slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
