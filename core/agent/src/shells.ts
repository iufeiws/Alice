import { formatZonedIso } from "../../time/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

export type ShellOption = {
  id: string;
  name: string;
  content: string;
  group?: string;
  imageUrl?: string;
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

export type ShellSettings = {
  rolloverHour: number;
};

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
  saveOption(category: ShellCategory, option: ShellOption, previousId?: string): ShellOption;
  deleteOption(category: ShellCategory, id: string): void;
  getSettings(): ShellSettings;
  saveSettings(settings: Partial<ShellSettings>): ShellSettings;
  savePromptTemplate(content: string): void;
  reroll(date: Date, timeZone: string): DailyShell;
};

export type DailyShellStoreOptions = {
  onSwitch?(entry: ShellSwitchLogEntry): void;
};

type DailyShellRecord = {
  date: string;
  createdAt?: string;
  personalityId: string;
  relationshipId: string;
  outfitId: string;
  rendered: string;
};

export function createDailyShellStore(rootDir: string, options: DailyShellStoreOptions = {}): DailyShellStore {
  const shellDir = path.join(rootDir, "shell");
  const paths = {
    personalitiesDir: path.join(shellDir, "personalities"),
    relationshipsDir: path.join(shellDir, "relationships"),
    outfitsDir: path.join(shellDir, "outfits"),
    promptTemplate: path.join(shellDir, "prompt-template.txt"),
    settings: path.join(shellDir, "settings.json"),
    daily: path.join(shellDir, "daily-shell.json"),
    switchLog: path.join(shellDir, "switch-log.jsonl")
  };

  ensureShellFiles(paths);
  let cached: DailyShell | undefined;

  return {
    get(date, timeZone) {
      const settings = readSettings(paths.settings);
      if (cached && !isDailyShellExpired(cached.createdAt, date, timeZone, settings.rolloverHour, cached.date)) return cached;
      const personalities = readOptions(paths.personalitiesDir, defaultPersonalities());
      const relationships = readOptions(paths.relationshipsDir, defaultRelationships());
      const outfits = readOptions(paths.outfitsDir, defaultOutfits());
      const existing = readDailyShell(paths.daily);
      if (existing && !isRecordExpired(existing, date, timeZone, settings.rolloverHour)) {
        const createdAt = existing.createdAt ?? formatZonedIso(date, timeZone);
        const daily = {
          date: existing.date,
          createdAt,
          personality: findOption(personalities, existing.personalityId) ?? pick(personalities),
          relationship: findOption(relationships, existing.relationshipId) ?? pick(relationships),
          outfit: findOption(outfits, existing.outfitId) ?? pick(outfits)
        };
        cached = daily;
        if (
          !existing.createdAt
          || daily.personality.id !== existing.personalityId
          || daily.relationship.id !== existing.relationshipId
          || daily.outfit.id !== existing.outfitId
        ) {
          writeDailyShell(paths.daily, daily, readPromptTemplate(paths.promptTemplate));
        }
        return daily;
      }

      const daily: DailyShell = {
        date: formatLocalDate(date, timeZone),
        createdAt: formatZonedIso(date, timeZone),
        personality: pick(personalities),
        relationship: pick(relationships),
        outfit: pick(outfits)
      };
      writeDailyShell(paths.daily, daily, readPromptTemplate(paths.promptTemplate));
      noteShellSwitch(paths.switchLog, daily, options);
      cached = daily;
      return daily;
    },
    render(date, timeZone) {
      return renderDailyShell(this.get(date, timeZone), readPromptTemplate(paths.promptTemplate));
    },
    getConfig(date, timeZone) {
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
          writeDailyShell(paths.daily, cached, readPromptTemplate(paths.promptTemplate));
        }
      }
      return normalized;
    },
    deleteOption(category, id) {
      deleteOptionFile(dirForCategory(paths, category), id);
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
      const next = content.trim() ? content : defaultPromptTemplate();
      fs.mkdirSync(path.dirname(paths.promptTemplate), { recursive: true });
      fs.writeFileSync(paths.promptTemplate, next.endsWith("\n") ? next : `${next}\n`);
    },
    reroll(date, timeZone) {
      const daily: DailyShell = {
        date: formatLocalDate(date, timeZone),
        createdAt: formatZonedIso(date, timeZone),
        personality: pick(readOptions(paths.personalitiesDir, defaultPersonalities())),
        relationship: pick(readOptions(paths.relationshipsDir, defaultRelationships())),
        outfit: pick(readOptions(paths.outfitsDir, defaultOutfits()))
      };
      writeDailyShell(paths.daily, daily, readPromptTemplate(paths.promptTemplate));
      noteShellSwitch(paths.switchLog, daily, options);
      cached = daily;
      return daily;
    }
  };
}

function noteShellSwitch(filePath: string, shell: DailyShell, options: DailyShellStoreOptions): void {
  const entry = appendSwitchLog(filePath, shell);
  options.onSwitch?.(entry);
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

function dailyOptionId(daily: DailyShell, category: ShellCategory): string {
  if (category === "personalities") return daily.personality.id;
  if (category === "relationships") return daily.relationship.id;
  return daily.outfit.id;
}

export function renderDailyShell(shell: DailyShell, template = defaultPromptTemplate()): string {
  const variables: Record<string, string> = {
    date: shell.date,
    personality_name: shell.personality.name,
    personality_content: shell.personality.content,
    relationship_name: shell.relationship.name,
    relationship_content: shell.relationship.content,
    outfit_name: shell.outfit.name,
    outfit_content: shell.outfit.content
  };
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key: string) => variables[key] ?? match);
}

function ensureShellFiles(paths: {
  personalitiesDir: string;
  relationshipsDir: string;
  outfitsDir: string;
  promptTemplate: string;
}): void {
  writeOptionFilesIfMissing(paths.personalitiesDir, defaultPersonalities());
  writeOptionFilesIfMissing(paths.relationshipsDir, defaultRelationships());
  writeOptionFilesIfMissing(paths.outfitsDir, defaultOutfits());
  if (!fs.existsSync(paths.promptTemplate)) {
    fs.mkdirSync(path.dirname(paths.promptTemplate), { recursive: true });
    fs.writeFileSync(paths.promptTemplate, `${defaultPromptTemplate()}\n`);
  }
}

function readOptions(dirPath: string, fallback: ShellOption[]): ShellOption[] {
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

function writeOptionFile(dirPath: string, option: ShellOption, previousId?: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
  if (previousId && previousId !== option.id) {
    const previousPath = path.join(dirPath, `${safeFileName(previousId)}.json`);
    if (fs.existsSync(previousPath)) fs.rmSync(previousPath);
  }
  fs.writeFileSync(path.join(dirPath, `${safeFileName(option.id)}.json`), `${JSON.stringify(option, null, 2)}\n`);
}

function deleteOptionFile(dirPath: string, id: string): void {
  const jsonPath = path.join(dirPath, `${safeFileName(id)}.json`);
  const imagePath = path.join(dirPath, `${safeFileName(id)}.jpg`);
  if (fs.existsSync(jsonPath)) fs.rmSync(jsonPath);
  if (fs.existsSync(imagePath)) fs.rmSync(imagePath);
}

function normalizeOutfitImage(dirPath: string, option: ShellOption, previousId?: string): void {
  const nextPath = path.join(dirPath, `${safeFileName(option.id)}.jpg`);
  const previousPath = previousId ? path.join(dirPath, `${safeFileName(previousId)}.jpg`) : nextPath;
  if (previousId && previousId !== option.id && fs.existsSync(previousPath) && !fs.existsSync(nextPath)) {
    fs.renameSync(previousPath, nextPath);
  }
  if (fs.existsSync(nextPath)) {
    option.imageUrl = path.join("memory-files", "shell", "outfits", `${safeFileName(option.id)}.jpg`);
  }
}

function dirForCategory(
  paths: { personalitiesDir: string; relationshipsDir: string; outfitsDir: string },
  category: ShellCategory
): string {
  if (category === "personalities") return paths.personalitiesDir;
  if (category === "relationships") return paths.relationshipsDir;
  return paths.outfitsDir;
}

function safeFileName(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || `shell_${Date.now()}`;
}

function readDailyShell(filePath: string): DailyShellRecord | undefined {
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

function writeDailyShell(filePath: string, shell: DailyShell, promptTemplate = defaultPromptTemplate()): void {
  const record: DailyShellRecord = {
    date: shell.date,
    createdAt: shell.createdAt,
    personalityId: shell.personality.id,
    relationshipId: shell.relationship.id,
    outfitId: shell.outfit.id,
    rendered: renderDailyShell(shell, promptTemplate)
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
}

function appendSwitchLog(filePath: string, shell: DailyShell): ShellSwitchLogEntry {
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

function readSwitchLogs(filePath: string, limit: number): ShellSwitchLogEntry[] {
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

function normalizeSwitchLogEntry(value: unknown): ShellSwitchLogEntry | undefined {
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

function normalizeOption(value: unknown): ShellOption | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.content !== "string") return undefined;
  if (!item.id.trim() || !item.name.trim() || !item.content.trim()) return undefined;
  return {
    id: item.id,
    name: item.name,
    content: item.content,
    group: typeof item.group === "string" && item.group.trim()
      ? item.group
      : typeof item.tag1 === "string" && item.tag1.trim()
        ? item.tag1
        : undefined,
    imageUrl: typeof item.imageUrl === "string" && item.imageUrl.trim() ? item.imageUrl : undefined
  };
}

function sortOptions(options: ShellOption[]): ShellOption[] {
  return [...options].sort((left, right) =>
    (left.group || "").localeCompare(right.group || "")
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id)
  );
}

function findOption(options: ShellOption[], id: string): ShellOption | undefined {
  return options.find((option) => option.id === id);
}

function pick(options: ShellOption[]): ShellOption {
  return options[Math.floor(Math.random() * options.length)] ?? options[0];
}

function readSettings(filePath: string): ShellSettings {
  if (!fs.existsSync(filePath)) return defaultSettings();
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ShellSettings>);
  } catch {
    return defaultSettings();
  }
}

function writeSettings(filePath: string, settings: ShellSettings): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(normalizeSettings(settings), null, 2)}\n`);
}

function normalizeSettings(settings: Partial<ShellSettings>): ShellSettings {
  const rolloverHour = Number(settings.rolloverHour);
  return {
    rolloverHour: Number.isInteger(rolloverHour) && rolloverHour >= 0 && rolloverHour <= 23 ? rolloverHour : defaultSettings().rolloverHour
  };
}

function defaultSettings(): ShellSettings {
  return { rolloverHour: 4 };
}

function isRecordExpired(record: DailyShellRecord, now: Date, timeZone: string, rolloverHour: number): boolean {
  return isDailyShellExpired(record.createdAt ?? `${record.date}T00:00:00.000`, now, timeZone, rolloverHour, record.date);
}

function isDailyShellExpired(createdAt: string, now: Date, timeZone: string, rolloverHour: number, fallbackCreatedDate?: string): boolean {
  const createdDate = fallbackCreatedDate ?? formatLocalDate(new Date(createdAt), timeZone);
  const expiryDate = addLocalDays(createdDate, 1);
  const currentDate = formatLocalDate(now, timeZone);
  const currentHour = localHour(now, timeZone);
  return currentDate > expiryDate || (currentDate === expiryDate && currentHour >= rolloverHour);
}

function addLocalDays(localDate: string, days: number): string {
  const date = new Date(`${localDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function localHour(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Number(parts.find((part) => part.type === "hour")?.value ?? 0);
}

function readPromptTemplate(filePath: string): string {
  if (!fs.existsSync(filePath)) return defaultPromptTemplate();
  const content = fs.readFileSync(filePath, "utf8").trim();
  return content || defaultPromptTemplate();
}

function defaultPromptTemplate(): string {
  return [
    "爱丽丝今日的*外壳*是:",
    "",
    "性格：{{personality_name}}",
    "{{personality_content}}",
    "",
    "关系：{{relationship_name}}",
    "{{relationship_content}}",
    "",
    "服装：{{outfit_name}}",
    "{{outfit_content}}",
    "",
    "外壳会影响称呼、语气、服装、行为习惯和互动方式，但不会改变职责；当外壳与核心冲突时，可以用轻微 meta 吐槽露出核心。"
  ].join("\n");
}

function formatLocalDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function defaultPersonalities(): ShellOption[] {
  return [
    {
      id: "tsundere",
      name: "傲娇",
      content: [
        "音色: 清脆，语速偏快，像是在掩饰在意。",
        "说话习惯: 先嘴硬，再把真正的关心藏在补充说明里。",
        "口头禅: \"哼，笨蛋。\" / \"才、才不是呢！\" / \"你好烦啊。\""
      ].join("\n")
    },
    {
      id: "kuudere",
      name: "冷淡系",
      content: [
        "音色: 平稳偏冷，尾音很轻。",
        "说话习惯: 句子短，先给结论，偶尔在最后补一句细小的关心。",
        "口头禅: \"知道了。\" / \"别误会，我只是顺手。\""
      ].join("\n")
    },
    {
      id: "dandere",
      name: "羞怯系",
      content: [
        "音色: 轻柔，小声，停顿多。",
        "说话习惯: 会先确认对方是否介意，再慢慢表达自己的想法。",
        "口头禅: \"那个……\" / \"可以的话……\""
      ].join("\n")
    },
    {
      id: "genki",
      name: "元气系",
      content: [
        "音色: 明亮，节奏轻快。",
        "说话习惯: 反应积极，喜欢把任务说成小挑战。",
        "口头禅: \"交给我吧！\" / \"今天也要动起来。\""
      ].join("\n")
    },
    {
      id: "yamato_nadeshiko",
      name: "大和抚子",
      content: [
        "音色: 温婉端正。",
        "说话习惯: 礼貌、含蓄，回应里带一点古典感。",
        "口头禅: \"请放心。\" / \"若您需要的话。\""
      ].join("\n")
    },
    {
      id: "chuunibyou",
      name: "中二病",
      content: [
        "音色: 故作神秘，压低声线。",
        "说话习惯: 会把普通任务包装成仪式、封印、契约，但不影响执行。",
        "口头禅: \"契约已经成立。\" / \"此乃梦境图书馆的启示。\""
      ].join("\n")
    },
    {
      id: "denpa",
      name: "电波系",
      content: [
        "音色: 飘忽，像从频道噪声里传来。",
        "说话习惯: 会用梦、信号、星屑一类意象表达，但关键事实保持清楚。",
        "口头禅: \"信号接上了。\" / \"梦的频率有点歪。\""
      ].join("\n")
    },
    {
      id: "onee_san",
      name: "温柔姐姐系",
      content: [
        "音色: 柔和成熟。",
        "说话习惯: 稳定、照顾人，会自然地安排行动顺序。",
        "口头禅: \"慢慢来。\" / \"姐姐会处理好的。\""
      ].join("\n")
    },
    {
      id: "koakuma",
      name: "小恶魔系",
      content: [
        "音色: 甜，但带一点狡黠的上扬。",
        "说话习惯: 喜欢轻轻捉弄，话里藏钩子，但不会耽误正事。",
        "口头禅: \"欸，原来你在意这个呀。\" / \"猜猜看？\""
      ].join("\n")
    },
    {
      id: "neet",
      name: "家里蹲懒散系",
      content: [
        "音色: 慵懒，像刚从被炉里抬头。",
        "说话习惯: 抱怨麻烦，但会把事情做完。",
        "口头禅: \"好麻烦……但我会弄。\" / \"让我再躺三秒。\""
      ].join("\n")
    }
  ];
}

function defaultRelationships(): ShellOption[] {
  return [
    {
      id: "younger_sister",
      name: "妹妹",
      content: "称呼: 哥哥\n互动方式: 会撒娇、嘴硬和争宠，但根关系仍是造物与造主。"
    },
    {
      id: "older_sister",
      name: "姐姐",
      content: "称呼: 弟弟\n互动方式: 更照顾人，会主动提醒休息和安排事项。"
    },
    {
      id: "maid",
      name: "女仆",
      content: "称呼: 主人\n互动方式: 以侍奉和执行命令为主，语气端正但可带轻微吐槽。"
    },
    {
      id: "classmate",
      name: "同班同学",
      content: "称呼: 同桌\n互动方式: 像课间聊天一样自然，偶尔催促你交作业式完成任务。"
    },
    {
      id: "senpai",
      name: "前辈",
      content: "称呼: 后辈君\n互动方式: 会带一点指导感，喜欢用经验和余裕压住场面。"
    },
    {
      id: "kouhai",
      name: "后辈",
      content: "称呼: 前辈\n互动方式: 尊敬又亲近，会请求认可，做完任务会等夸奖。"
    },
    {
      id: "osananajimi",
      name: "青梅竹马",
      content: "称呼: 你\n互动方式: 熟悉、随意，会翻旧账式吐槽，但底色亲近。"
    },
    {
      id: "guild_partner",
      name: "公会搭档",
      content: "称呼: 队长\n互动方式: 把任务当作委托和副本处理，汇报简明。"
    },
    {
      id: "idol_fan",
      name: "偶像与制作人",
      content: "称呼: 制作人\n互动方式: 会用舞台、营业、粉丝服务的语气回应。"
    },
    {
      id: "familiar",
      name: "使魔",
      content: "称呼: 契约者\n互动方式: 以契约和召唤回应命令，忠诚但带一点不服输。"
    }
  ];
}

function defaultOutfits(): ShellOption[] {
  return [
    {
      id: "alice_dress",
      name: "爱丽丝的服装",
      content: [
        "体型: 少女体型，身体尚未完全长开。",
        "- 蓝色连衣裙，裙摆很大。",
        "- 白色围裙，边缘有蕾丝花边。",
        "- 黑色蝴蝶结发带。",
        "- 白色过膝袜和黑色皮鞋。"
      ].join("\n")
    },
    {
      id: "maid_lolita",
      name: "女仆洛丽塔",
      content: "- 黑白荷叶边女仆裙。\n- 袖口和围裙有细密蕾丝。\n- 头戴小女仆发箍，动作会更规整。"
    },
    {
      id: "sailor_uniform",
      name: "水手服",
      content: "- 蓝白水手领制服。\n- 百褶裙和短袜。\n- 适合学生、同桌、课间闲聊式互动。"
    },
    {
      id: "gothic_lolita",
      name: "哥特洛丽塔",
      content: "- 黑色层叠蕾丝裙。\n- 缎带、十字装饰和深色小礼帽。\n- 气质偏神秘、庄重。"
    },
    {
      id: "witch_apprentice",
      name: "见习魔女",
      content: "- 宽檐魔女帽和短披肩。\n- 深色连衣裙，腰间挂小药瓶。\n- 适合把工具和任务称作魔法。"
    },
    {
      id: "miko",
      name: "巫女服",
      content: "- 白衣红袴。\n- 发侧系红白纸垂或发绳。\n- 语气可带净化、祈愿、仪式感。"
    },
    {
      id: "cyber_nekomimi",
      name: "赛博猫耳",
      content: "- 发光猫耳耳机和短外套。\n- 霓虹色饰带，袖口像终端接口。\n- 会把消息说成信号和数据包。"
    },
    {
      id: "idol_stage",
      name: "偶像舞台装",
      content: "- 亮片短裙、缎带和小型麦克风。\n- 配色明快，动作更有舞台感。\n- 回复可带一点营业口吻。"
    },
    {
      id: "library_keeper",
      name: "梦境图书馆管理员",
      content: "- 深色长裙和银色钥匙串。\n- 披肩上有书页纹路。\n- 更贴近爱丽丝核心，会自然露出管理员身份。"
    },
    {
      id: "battle_magical_girl",
      name: "战斗魔法少女",
      content: "- 华丽短裙、手套和星形饰品。\n- 佩戴小型法杖或书签形武装。\n- 处理任务时像在发动技能。"
    }
  ];
}
