const fs = await import("node:fs");
const path = await import("node:path");

export type CoreProfile = {
  appearanceDescription: string;
};

export type CoreProfileStore = {
  get(): CoreProfile;
  save(profile: Partial<CoreProfile>): CoreProfile;
};

export function defaultCoreProfile(): CoreProfile {
  return {
    appearanceDescription: ""
  };
}

export function createCoreProfileStore(filePath: string): CoreProfileStore {
  let current = readCoreProfile(filePath) ?? defaultCoreProfile();
  if (!fs.existsSync(filePath)) writeCoreProfile(filePath, current);

  return {
    get() {
      return { ...current };
    },
    save(profile) {
      current = normalizeCoreProfile({ ...current, ...profile });
      writeCoreProfile(filePath, current);
      return { ...current };
    }
  };
}

function readCoreProfile(filePath: string): CoreProfile | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return normalizeCoreProfile(JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<CoreProfile>);
  } catch {
    return undefined;
  }
}

function writeCoreProfile(filePath: string, profile: CoreProfile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(normalizeCoreProfile(profile), null, 2)}\n`);
}

function normalizeCoreProfile(profile: Partial<CoreProfile>): CoreProfile {
  return {
    appearanceDescription: typeof profile.appearanceDescription === "string" ? profile.appearanceDescription : ""
  };
}
