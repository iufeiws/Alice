import { formatZonedIso } from "../../../../platform/time/src/index.js";
import { findOutfit, pickOutfit } from "./outfit.js";
import { defaultOutfits, defaultPersonalities, defaultPromptTemplate, defaultRelationships } from "./shell-defaults.js";
import { findOption, formatLocalDate, normalizeOption, normalizeRecentRelationshipIds, normalizeSettings, pick, pickExcludingRecent, renderShellTemplate, sameStringArray, updateRecentRelationshipIds } from "./shell-normalizers.js";
import { appendSwitchLog, deleteOptionFile, dirForCategory, ensureShellFiles, normalizeOutfitImage, readDailyShell, readOptions, readPromptTemplate, readRecentRelationshipIds, readSettings, readSwitchLogs, savePromptTemplate, shellPaths, writeDailyShell, writeOptionFile, writeSettings } from "./shell-store-files.js";
import type { DailyShell, DailyShellStore, DailyShellStoreOptions, ShellCategory, ShellConfig, ShellOption } from "./shell-types.js";

export type * from "./shell-types.js";

export function createDailyShellStore(rootDir: string, options: DailyShellStoreOptions = {}): DailyShellStore {
  const paths = shellPaths(rootDir, options);

  ensureShellFiles(paths);
  let cached: DailyShell | undefined;
  let cachedRecentRelationshipIds: string[] = [];

  return {
    get(date, timeZone) {
      const personalities = readOptions(paths.personalitiesDir, defaultPersonalities());
      const relationships = readOptions(paths.relationshipsDir, defaultRelationships());
      const outfits = readOptions(paths.outfitsDir, defaultOutfits());
      const existing = readDailyShell(paths.daily);
      if (existing) {
        const createdAt = existing.createdAt ?? formatZonedIso(date, timeZone);
        const daily = {
          date: existing.date,
          createdAt,
          personality: findOption(personalities, existing.personalityId) ?? pick(personalities),
          relationship: findOption(relationships, existing.relationshipId) ?? pick(relationships),
          outfit: findOutfit(outfits, existing.outfitId) ?? pickOutfit(outfits)
        };
        cachedRecentRelationshipIds = normalizeRecentRelationshipIds(existing.recentRelationshipIds, relationships);
        const nextRecentRelationshipIds = updateRecentRelationshipIds(
          daily.relationship.id,
          cachedRecentRelationshipIds,
          relationships.length
        );
        cached = daily;
        if (
          !existing.createdAt
          || daily.personality.id !== existing.personalityId
          || daily.relationship.id !== existing.relationshipId
          || daily.outfit.id !== existing.outfitId
          || !sameStringArray(nextRecentRelationshipIds, cachedRecentRelationshipIds)
        ) {
          cachedRecentRelationshipIds = nextRecentRelationshipIds;
          writeDailyShell(paths.daily, daily, readPromptTemplate(paths.promptTemplate), cachedRecentRelationshipIds);
        }
        return daily;
      }

      const relationship = pickExcludingRecent(relationships, cachedRecentRelationshipIds);
      const daily: DailyShell = {
        date: formatLocalDate(date, timeZone),
        createdAt: formatZonedIso(date, timeZone),
        personality: pick(personalities),
        relationship,
        outfit: pickOutfit(outfits)
      };
      cachedRecentRelationshipIds = updateRecentRelationshipIds(relationship.id, cachedRecentRelationshipIds, relationships.length);
      writeDailyShell(paths.daily, daily, readPromptTemplate(paths.promptTemplate), cachedRecentRelationshipIds);
      const entry = appendSwitchLog(paths.switchLog, daily);
      options.onSwitch?.(entry);
      cached = daily;
      return daily;
    },
    render(date, timeZone) {
      return renderDailyShell(this.get(date, timeZone), readPromptTemplate(paths.promptTemplate));
    },
    getConfig(date, timeZone): ShellConfig {
      const daily = this.get(date, timeZone);
      return {
        daily,
        rendered: renderDailyShell(daily, readPromptTemplate(paths.promptTemplate)),
        personalities: readOptions(paths.personalitiesDir, defaultPersonalities()),
        relationships: readOptions(paths.relationshipsDir, defaultRelationships()),
        outfits: readOptions(paths.outfitsDir, defaultOutfits()),
        promptTemplate: readPromptTemplate(paths.promptTemplate),
        settings: readSettings(paths.settings)
      };
    },
    listSwitchLogs(limit = 200) {
      return readSwitchLogs(paths.switchLog, limit);
    },
    switchOutfit(date, timeZone, outfitId) {
      const outfits = readOptions(paths.outfitsDir, defaultOutfits());
      const outfit = findOutfit(outfits, outfitId);
      if (!outfit) throw new Error("unknown_outfit");
      const current = this.get(date, timeZone);
      const daily: DailyShell = {
        date: current.date,
        createdAt: current.createdAt,
        personality: current.personality,
        relationship: current.relationship,
        outfit
      };
      writeDailyShell(paths.daily, daily, readPromptTemplate(paths.promptTemplate), cachedRecentRelationshipIds);
      cached = daily;
      return daily;
    },
    saveOption(category, option, previousId) {
      const normalized = normalizeOption(option);
      if (!normalized) {
        throw new Error("invalid_shell_option");
      }
      if (category === "outfits") {
        normalizeOutfitImage(paths.outfitsDir, normalized, previousId);
      }
      writeOptionFile(dirForCategory(paths, category), normalized, previousId);
      if (cached) {
        const nextCached = replaceDailyOption(cached, category, normalized, previousId);
        if (nextCached !== cached) {
          cached = nextCached;
          if (category === "relationships") {
            cachedRecentRelationshipIds = replaceRecentRelationshipId(cachedRecentRelationshipIds, normalized.id, previousId);
          }
          writeDailyShell(paths.daily, cached, readPromptTemplate(paths.promptTemplate), cachedRecentRelationshipIds);
        }
      }
      return normalized;
    },
    deleteOption(category, id) {
      deleteOptionFile(dirForCategory(paths, category), id);
      if (category === "relationships") {
        cachedRecentRelationshipIds = cachedRecentRelationshipIds.filter((recentId) => recentId !== id);
      }
      if (cached && dailyOptionId(cached, category) === id) cached = undefined;
    },
    getSettings() {
      return readSettings(paths.settings);
    },
    saveSettings(settings) {
      const next = normalizeSettings({ ...readSettings(paths.settings), ...settings });
      writeSettings(paths.settings, next);
      return next;
    },
    savePromptTemplate(content) {
      savePromptTemplate(paths.promptTemplate, content);
    },
    reroll(date, timeZone) {
      const personalities = readOptions(paths.personalitiesDir, defaultPersonalities());
      const relationships = readOptions(paths.relationshipsDir, defaultRelationships());
      if (cachedRecentRelationshipIds.length === 0) {
        cachedRecentRelationshipIds = readRecentRelationshipIds(paths.daily, relationships);
      }
      cachedRecentRelationshipIds = normalizeRecentRelationshipIds(cachedRecentRelationshipIds, relationships);
      const relationship = pickExcludingRecent(relationships, cachedRecentRelationshipIds);
      const daily: DailyShell = {
        date: formatLocalDate(date, timeZone),
        createdAt: formatZonedIso(date, timeZone),
        personality: pick(personalities),
        relationship,
        outfit: pickOutfit(readOptions(paths.outfitsDir, defaultOutfits()))
      };
      cachedRecentRelationshipIds = updateRecentRelationshipIds(relationship.id, cachedRecentRelationshipIds, relationships.length);
      writeDailyShell(paths.daily, daily, readPromptTemplate(paths.promptTemplate), cachedRecentRelationshipIds);
      const entry = appendSwitchLog(paths.switchLog, daily);
      options.onSwitch?.(entry);
      cached = daily;
      return daily;
    }
  };
}

function replaceDailyOption(daily: DailyShell, category: ShellCategory, option: ShellOption, previousId?: string): DailyShell {
  if (category === "personalities" && (daily.personality.id === previousId || daily.personality.id === option.id)) {
    return { ...daily, personality: option };
  }
  if (category === "relationships" && (daily.relationship.id === previousId || daily.relationship.id === option.id)) {
    return { ...daily, relationship: option };
  }
  if (category === "outfits" && (daily.outfit.id === previousId || daily.outfit.id === option.id)) {
    return { ...daily, outfit: option };
  }
  return daily;
}

function replaceRecentRelationshipId(recentIds: string[], nextId: string, previousId?: string): string[] {
  if (!previousId || previousId === nextId) return recentIds;
  return recentIds.map((id) => id === previousId ? nextId : id);
}

function dailyOptionId(daily: DailyShell, category: ShellCategory): string {
  if (category === "personalities") return daily.personality.id;
  if (category === "relationships") return daily.relationship.id;
  return daily.outfit.id;
}

export function renderDailyShell(shell: DailyShell, template = defaultPromptTemplate()): string {
  return renderShellTemplate(shell, template);
}
