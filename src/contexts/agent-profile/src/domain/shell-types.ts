export type ShellOption = {
  id: string;
  name: string;
  content: string;
  group?: string;
  imageUrl?: string;
  onBodyImageUrl?: string;
  outfitImageGenerated?: boolean;
  onBodyGenerationAttempted?: boolean;
};

export type DailyShell = {
  date: string;
  createdAt: string;
  personality: ShellOption;
  relationship: ShellOption;
  outfit: ShellOption;
};

export type ShellSwitchLogEntry = {
  time: string;
  date: string;
  personalityName: string;
  relationshipName: string;
  outfitName: string;
  message: string;
};

export type ShellSettings = Record<string, never>;

export type ShellCategory = "personalities" | "relationships" | "outfits";

export type ShellConfig = {
  daily: DailyShell;
  rendered: string;
  personalities: ShellOption[];
  relationships: ShellOption[];
  outfits: ShellOption[];
  promptTemplate: string;
  settings: ShellSettings;
};

export type DailyShellStore = {
  get(date: Date, timeZone: string): DailyShell;
  render(date: Date, timeZone: string): string;
  getConfig(date: Date, timeZone: string): ShellConfig;
  listSwitchLogs(limit?: number): ShellSwitchLogEntry[];
  switchOutfit(date: Date, timeZone: string, outfitId: string): DailyShell;
  saveOption(category: ShellCategory, option: ShellOption, previousId?: string): ShellOption;
  deleteOption(category: ShellCategory, id: string): void;
  getSettings(): ShellSettings;
  saveSettings(settings: Partial<ShellSettings>): ShellSettings;
  savePromptTemplate(content: string): void;
  reroll(date: Date, timeZone: string): DailyShell;
};

export type DailyShellStoreOptions = {
  promptTemplatePath?: string;
  onSwitch?(entry: ShellSwitchLogEntry): void;
};

export type DailyShellRecord = {
  date: string;
  createdAt?: string;
  personalityId: string;
  relationshipId: string;
  outfitId: string;
  recentRelationshipIds?: string[];
  rendered: string;
};
