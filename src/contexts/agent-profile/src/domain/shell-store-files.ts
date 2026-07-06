import { promptStoragePath } from "../adapters/json-prompt-profile-store.js";
import { defaultOutfits, defaultPersonalities, defaultPromptTemplate, defaultRelationships } from "./shell-defaults.js";
import { defaultSettings, normalizeOption, normalizeRecentRelationshipIds, normalizeSettings, normalizeSwitchLogEntry, renderShellTemplate, sortOptions } from "./shell-normalizers.js";
import type { DailyShell, DailyShellRecord, DailyShellStoreOptions, ShellCategory, ShellOption, ShellSettings, ShellSwitchLogEntry } from "./shell-types.js";

const fs = await import("node:fs");
const path = await import("node:path");

export type ShellPaths = {
  personalitiesDir: string;
  relationshipsDir: string;
  outfitsDir: string;
  promptTemplate: string;
  settings: string;
  daily: string;
  switchLog: string;
};

export function shellPaths(rootDir: string, options: DailyShellStoreOptions): ShellPaths {
  const shellDir = path.join(rootDir, "shell");
  return {
    personalitiesDir: path.join(shellDir, "personalities"),
    relationshipsDir: path.join(shellDir, "relationships"),
    outfitsDir: path.join(shellDir, "outfits"),
    promptTemplate: options.promptTemplatePath ?? promptStoragePath(rootDir, "shell-prompt-template.txt"),
    settings: path.join(shellDir, "settings.json"),
    daily: path.join(shellDir, "daily-shell.json"),
    switchLog: path.join(shellDir, "switch-log.jsonl")
  };
}

export function ensureShellFiles(paths: Pick<ShellPaths, "personalitiesDir" | "relationshipsDir" | "outfitsDir" | "promptTemplate">): void {
  writeOptionFilesIfMissing(paths.personalitiesDir, defaultPersonalities());
  writeOptionFilesIfMissing(paths.relationshipsDir, defaultRelationships());
  writeOptionFilesIfMissing(paths.outfitsDir, defaultOutfits());
  if (!fs.existsSync(paths.promptTemplate)) {
    fs.mkdirSync(path.dirname(paths.promptTemplate), { recursive: true });
    fs.writeFileSync(paths.promptTemplate, `${defaultPromptTemplate()}\n`);
  }
}

export function readOptions(dirPath: string, fallback: ShellOption[]): ShellOption[] {
  const fileOptions = readOptionFiles(dirPath);
  if (fileOptions.length > 0) return sortOptions(fileOptions);
  return sortOptions(fallback);
}

function readOptionFiles(dirPath: string): ShellOption[] {
  if (!fs.existsSync(dirPath)) return [];
  const options: ShellOption[] = [];
  let fileNames: string[];
  try {
    fileNames = fs.readdirSync(dirPath).sort();
  } catch {
    return [];
  }
  for (const fileName of fileNames) {
    if (!fileName.endsWith(".json")) continue;
    try {
      const option = normalizeOption(JSON.parse(fs.readFileSync(path.join(dirPath, fileName), "utf8")) as unknown);
      if (option) options.push(option);
    } catch {
      // Ignore broken option files so one bad shell does not disable the category.
    }
  }
  return options;
}

function writeOptionFilesIfMissing(dirPath: string, options: ShellOption[]): void {
  if (readOptionFiles(dirPath).length > 0) return;
  writeOptionFiles(dirPath, options);
}

function writeOptionFiles(dirPath: string, options: ShellOption[]): void {
  fs.mkdirSync(dirPath, { recursive: true });
  const expected = new Set<string>();
  for (const option of sortOptions(options)) {
    const fileName = `${safeFileName(option.id)}.json`;
    expected.add(fileName);
    fs.writeFileSync(path.join(dirPath, fileName), `${JSON.stringify(option, null, 2)}\n`);
  }
  for (const fileName of fs.readdirSync(dirPath)) {
    if (fileName.endsWith(".json") && !expected.has(fileName)) {
      fs.rmSync(path.join(dirPath, fileName));
    }
  }
}

export function writeOptionFile(dirPath: string, option: ShellOption, previousId?: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
  if (previousId && previousId !== option.id) {
    const previousPath = path.join(dirPath, `${safeFileName(previousId)}.json`);
    if (fs.existsSync(previousPath)) fs.rmSync(previousPath);
  }
  fs.writeFileSync(path.join(dirPath, `${safeFileName(option.id)}.json`), `${JSON.stringify(option, null, 2)}\n`);
}

export function deleteOptionFile(dirPath: string, id: string): void {
  const jsonPath = path.join(dirPath, `${safeFileName(id)}.json`);
  const imagePath = path.join(dirPath, `${safeFileName(id)}.jpg`);
  if (fs.existsSync(jsonPath)) fs.rmSync(jsonPath);
  if (fs.existsSync(imagePath)) fs.rmSync(imagePath);
}

export function normalizeOutfitImage(dirPath: string, option: ShellOption, previousId?: string): void {
  const nextPath = path.join(dirPath, `${safeFileName(option.id)}.jpg`);
  const previousPath = previousId ? path.join(dirPath, `${safeFileName(previousId)}.jpg`) : nextPath;
  if (previousId && previousId !== option.id && fs.existsSync(previousPath) && !fs.existsSync(nextPath)) {
    fs.renameSync(previousPath, nextPath);
  }
  if (fs.existsSync(nextPath)) {
    option.imageUrl = path.join("memory-files", "shell", "outfits", `${safeFileName(option.id)}.jpg`);
  }
}

export function dirForCategory(
  paths: Pick<ShellPaths, "personalitiesDir" | "relationshipsDir" | "outfitsDir">,
  category: ShellCategory
): string {
  if (category === "personalities") return paths.personalitiesDir;
  if (category === "relationships") return paths.relationshipsDir;
  return paths.outfitsDir;
}

export function safeFileName(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || `shell_${Date.now()}`;
}

export function readDailyShell(filePath: string): DailyShellRecord | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as DailyShellRecord;
    if (
      typeof parsed.date === "string"
      && typeof parsed.personalityId === "string"
      && typeof parsed.relationshipId === "string"
      && typeof parsed.outfitId === "string"
    ) {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function readRecentRelationshipIds(filePath: string, relationships: ShellOption[]): string[] {
  return normalizeRecentRelationshipIds(readDailyShell(filePath)?.recentRelationshipIds, relationships);
}

export function writeDailyShell(
  filePath: string,
  shell: DailyShell,
  promptTemplate = defaultPromptTemplate(),
  recentRelationshipIds: string[] = []
): void {
  const record: DailyShellRecord = {
    date: shell.date,
    createdAt: shell.createdAt,
    personalityId: shell.personality.id,
    relationshipId: shell.relationship.id,
    outfitId: shell.outfit.id,
    recentRelationshipIds,
    rendered: renderShellTemplate(shell, promptTemplate)
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
}

export function appendSwitchLog(filePath: string, shell: DailyShell): ShellSwitchLogEntry {
  const entry: ShellSwitchLogEntry = {
    time: shell.createdAt,
    date: shell.date,
    personalityName: shell.personality.name,
    relationshipName: shell.relationship.name,
    outfitName: shell.outfit.name,
    message: `切换到${shell.personality.name}的${shell.relationship.name}爱丽丝`
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
  return entry;
}

export function readSwitchLogs(filePath: string, limit: number): ShellSwitchLogEntry[] {
  if (!fs.existsSync(filePath)) return [];
  const safeLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
  try {
    return fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-safeLimit)
      .map((line) => normalizeSwitchLogEntry(JSON.parse(line) as unknown))
      .filter((entry): entry is ShellSwitchLogEntry => Boolean(entry));
  } catch {
    return [];
  }
}

export function readSettings(filePath: string): ShellSettings {
  if (!fs.existsSync(filePath)) return defaultSettings();
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ShellSettings>);
  } catch {
    return defaultSettings();
  }
}

export function writeSettings(filePath: string, settings: ShellSettings): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(normalizeSettings(settings), null, 2)}\n`);
}

export function readPromptTemplate(filePath: string): string {
  if (!fs.existsSync(filePath)) return defaultPromptTemplate();
  const content = fs.readFileSync(filePath, "utf8").trim();
  return content || defaultPromptTemplate();
}

export function savePromptTemplate(filePath: string, content: string): void {
  const next = content.trim() ? content : defaultPromptTemplate();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next.endsWith("\n") ? next : `${next}\n`);
}
