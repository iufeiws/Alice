import type { DiaryStore, SleepBoundary } from '../../../platform/storage/src/diary-store.js';
import type { StoredConversationMessage } from '../../../contexts/conversation-hub/src/adapters/sqlite-conversation-store.js';
import { formatZonedIso, parseZonedIso } from '../../../platform/time/src/index.js';
import type { MemorySleepWindow, SleepMemoryState, SleepMemoryStateStore } from './model.js';
import { writeAtomic } from './store.js';
import { stringValue } from './text-utils.js';

const fs = await import('node:fs');
const path = await import('node:path');

export function createSleepMemoryStateStore(filePath: string): SleepMemoryStateStore {
  return {
    read() {
      if (!fs.existsSync(filePath)) return {};
      try {
        return normalizeSleepMemoryState(JSON.parse(fs.readFileSync(filePath, "utf8")) as SleepMemoryState);
      } catch {
        return {};
      }
    },
    write(state) {
      const normalized = normalizeSleepMemoryState(state);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      writeAtomic(filePath, `${JSON.stringify(normalized, null, 2)}\n`);
      return normalized;
    }
  };
}

export function listMemorySleepWindows(input: {
  diaryStore: Pick<DiaryStore, "listSleepBoundaries" | "recordSleepBoundary">;
  timeZone: string;
  messages?: StoredConversationMessage[];
  now?: () => { iso: string; utcIso?: string };
}): MemorySleepWindow[] {
  const boundaries = input.diaryStore.listSleepBoundaries();
  if (boundaries.length === 1) {
    const boundary = boundaries[0];
    const end = memoryBoundaryInstant(boundary, input.timeZone);
    return [{
      date: memorySleepBoundaryLocalDate(boundary, input.timeZone),
      endAt: formatZonedIso(end, input.timeZone),
      endAtUtc: end.toISOString(),
      source: boundary.source
    }];
  }
  return boundaries.slice(1).map((boundary, index) => {
    const previous = boundaries[index];
    const start = memoryBoundaryInstant(previous, input.timeZone);
    const end = memoryBoundaryInstant(boundary, input.timeZone);
    return {
      date: memorySleepBoundaryLocalDate(boundary, input.timeZone),
      startAt: formatZonedIso(start, input.timeZone),
      endAt: formatZonedIso(end, input.timeZone),
      startAtUtc: start.toISOString(),
      endAtUtc: end.toISOString(),
      source: boundary.source
    };
  }).reverse();
}

export function latestMemorySleepWindow(input: {
  diaryStore: Pick<DiaryStore, "listSleepBoundaries" | "recordSleepBoundary">;
  timeZone: string;
  messages?: StoredConversationMessage[];
  now?: () => { iso: string; utcIso?: string };
}): MemorySleepWindow | undefined {
  return listMemorySleepWindows(input)[0];
}

export function resolveMemorySleepWindowForDate(input: {
  diaryStore: Pick<DiaryStore, "listSleepBoundaries" | "recordSleepBoundary">;
  date: string;
  timeZone: string;
  messages?: StoredConversationMessage[];
  now?: () => { iso: string; utcIso?: string };
}): MemorySleepWindow | undefined {
  return listMemorySleepWindows(input).find((window) => window.date === input.date);
}

function memorySleepBoundaryLocalDate(boundary: SleepBoundary, timeZone: string): string {
  return formatZonedIso(memoryBoundaryInstant(boundary, timeZone), timeZone).slice(0, 10);
}

function memoryBoundaryInstant(boundary: SleepBoundary, timeZone: string): Date {
  return boundary.occurredAtUtc ? new Date(boundary.occurredAtUtc) : new Date(parseMemoryMessageCreatedAt(boundary.occurredAt, timeZone));
}

function parseMemoryMessageCreatedAt(value: string, timeZone: string): number {
  return /Z$|[+-]\d{2}:\d{2}$/.test(value) ? new Date(value).getTime() : parseZonedIso(value, timeZone).getTime();
}

function normalizeSleepMemoryState(value: SleepMemoryState): SleepMemoryState {
  return {
    lastInductionAt: stringValue(value.lastInductionAt),
    currentInductionAt: stringValue(value.currentInductionAt),
    lastBackfillAt: stringValue(value.lastBackfillAt),
    lastSuccessAt: stringValue(value.lastSuccessAt),
    lastFailureAt: stringValue(value.lastFailureAt),
    lastFailure: stringValue(value.lastFailure)
  };
}
