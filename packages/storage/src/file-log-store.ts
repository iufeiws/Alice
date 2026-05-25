const fs = await import("node:fs");
const path = await import("node:path");

export type FileSystemLogEntry = {
  id: number;
  time: string;
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
  let nextId = Math.max(1, ...readAll(root).map((entry) => entry.id + 1));
  const getTimeZone = options.getTimeZone ?? (() => options.timeZone);

  return {
    append(input) {
      const entry: FileSystemLogEntry = {
        id: nextId,
        ...input
      };
      nextId += 1;

      fs.appendFileSync(logPathFor(root, input.time, getTimeZone()), `${JSON.stringify(entry)}\n`);
      return entry;
    },
    listRecent(limit) {
      return readAll(root).slice(-limit);
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

function readAll(root: string): FileSystemLogEntry[] {
  if (!fs.existsSync(root)) return [];
  const entries: FileSystemLogEntry[] = [];
  for (const file of fs.readdirSync(root).filter((item) => item.endsWith(".log.jsonl")).sort()) {
    const content = fs.readFileSync(path.join(root, file), "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as FileSystemLogEntry);
      } catch {
        // Ignore malformed debug lines.
      }
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
