import type { ShellOption, ShellSettings, ShellSwitchLogEntry } from "./shell-types.js";

export function renderShellTemplate(shell: {
  date: string;
  personality: ShellOption;
  relationship: ShellOption;
  outfit: ShellOption;
}, template: string): string {
  const variables: Record<string, string> = {
    date: shell.date,
    personality_name: shell.personality.name,
    personality_content: shell.personality.content,
    relationship_name: shell.relationship.name,
    relationship_content: shell.relationship.content,
    outfit_name: shell.outfit.name,
    outfit_content: shell.outfit.content
  };
  return template.replace(/\$\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key: string) => variables[key] ?? match);
}

export function normalizeSwitchLogEntry(value: unknown): ShellSwitchLogEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<Record<keyof ShellSwitchLogEntry, unknown>>;
  const time = typeof record.time === "string" ? record.time : "";
  const date = typeof record.date === "string" ? record.date : "";
  const personalityName = typeof record.personalityName === "string" ? record.personalityName : "";
  const relationshipName = typeof record.relationshipName === "string" ? record.relationshipName : "";
  const outfitName = typeof record.outfitName === "string" ? record.outfitName : "";
  if (!time || !personalityName || !relationshipName) return undefined;
  return {
    time,
    date,
    personalityName,
    relationshipName,
    outfitName,
    message: typeof record.message === "string" && record.message
      ? record.message
      : `切换到${personalityName}的${relationshipName}爱丽丝`
  };
}

export function normalizeOption(value: unknown): ShellOption | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.content !== "string") return undefined;
  if (!item.id.trim() || !item.name.trim() || !item.content.trim()) return undefined;
  const onBodyImageUrl = typeof item.onBodyImageUrl === "string" && item.onBodyImageUrl.trim() ? item.onBodyImageUrl : undefined;
  return {
    id: item.id,
    name: item.name,
    content: item.content,
    group: typeof item.group === "string" && item.group.trim()
      ? item.group
      : typeof item.tag1 === "string" && item.tag1.trim()
        ? item.tag1
        : undefined,
    enabled: item.enabled !== false,
    imageUrl: typeof item.imageUrl === "string" && item.imageUrl.trim() ? item.imageUrl : undefined,
    onBodyImageUrl,
    outfitImageGenerated: item.outfitImageGenerated === true || undefined,
    onBodyGenerationAttempted: item.onBodyGenerationAttempted === true || item.outfitImageGenerated === true || Boolean(onBodyImageUrl) || undefined
  };
}

export function sortOptions(options: ShellOption[]): ShellOption[] {
  return [...options].sort((left, right) =>
    (left.group || "").localeCompare(right.group || "")
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id)
  );
}

export function findOption(options: ShellOption[], id: string): ShellOption | undefined {
  return options.find((option) => option.id === id);
}

export function enabledOptions(options: ShellOption[]): ShellOption[] {
  const enabled = options.filter((option) => option.enabled !== false);
  return enabled.length > 0 ? enabled : options;
}

export function pick(options: ShellOption[]): ShellOption {
  const pool = enabledOptions(options);
  return pool[Math.floor(Math.random() * pool.length)] ?? pool[0];
}

export function pickExcludingRecent(options: ShellOption[], recentIds: string[]): ShellOption {
  const blocked = new Set(recentIds);
  const pool = enabledOptions(options);
  const candidates = pool.filter((option) => !blocked.has(option.id));
  return pick(candidates.length > 0 ? candidates : pool);
}

export function normalizeRecentRelationshipIds(value: unknown, relationships: ShellOption[]): string[] {
  if (!Array.isArray(value)) return [];
  const validIds = new Set(relationships.map((option) => option.id));
  const uniqueIds: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !validIds.has(item) || uniqueIds.includes(item)) continue;
    uniqueIds.push(item);
  }
  return trimRecentRelationshipIds(uniqueIds, relationships.length);
}

export function updateRecentRelationshipIds(selectedId: string, previousIds: string[], relationshipCount: number): string[] {
  return trimRecentRelationshipIds([selectedId, ...previousIds.filter((id) => id !== selectedId)], relationshipCount);
}

function trimRecentRelationshipIds(ids: string[], relationshipCount: number): string[] {
  const limit = Math.min(7, Math.max(relationshipCount - 2, 0));
  return ids.slice(0, limit);
}

export function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function normalizeSettings(_settings: Partial<ShellSettings>): ShellSettings {
  return {};
}

export function defaultSettings(): ShellSettings {
  return {};
}

export function formatLocalDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
