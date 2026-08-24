const fs = await import("node:fs");
const path = await import("node:path");

export type SkillMetadata = {
  id: string;
  name: string;
  description: string;
  version?: string;
  allowedTools?: string[];
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  disabled?: boolean;
  unsupported?: "fork" | "dynamic-context";
  hostRoot: string;
  instructionPath: string;
  sandboxRoot: string;
  source: "first-party" | "third-party";
};

export type SkillRegistry = {
  list(): SkillMetadata[];
  available(): SkillMetadata[];
  get(name: string): SkillMetadata | undefined;
};

export type SkillRootConfig = {
  root: string;
  source: SkillMetadata["source"];
  sandboxRoot?: string;
};

export function createSkillRegistry(input: { roots: SkillRootConfig[] }): SkillRegistry {
  const scan = () => {
    const scanned = input.roots.flatMap((root) => scanSkillRoot(root));
    const duplicatedNames = duplicated(scanned.map((skill) => skill.name));
    return scanned.filter((skill) => !duplicatedNames.has(skill.name)).sort((a, b) => a.name.localeCompare(b.name));
  };
  return {
    list: scan,
    available: () => scan().filter(isAvailableSkill),
    get: (name) => scan().find((skill) => skill.name === name)
  };
}

export function formatAvailableSkillsXml(registry: SkillRegistry, source?: SkillMetadata["source"], tag = "available_skills"): string {
  const skills = source === undefined ? registry.available() : registry.available().filter((skill) => skill.source === source);
  if (skills.length === 0) return `<${tag}>\n</${tag}>`;
  return [
    `<${tag}>`,
    ...skills.map((skill) => [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      "  </skill>"
    ].join("\n")),
    `</${tag}>`
  ].join("\n");
}

function isAvailableSkill(skill: SkillMetadata): boolean {
  return !skill.disabled && !skill.disableModelInvocation && !skill.unsupported;
}

function scanSkillRoot(config: SkillRootConfig): SkillMetadata[] {
  const root = path.resolve(config.root);
  if (!fs.existsSync(root)) return [];
  const found: SkillMetadata[] = [];
  for (const instructionPath of findSkillFiles(root)) {
    const hostRoot = path.dirname(instructionPath);
    if (!isInside(hostRoot, root)) continue;
    const relativeRoot = path.relative(root, hostRoot).split(path.sep).join("/");
    if (config.source === "first-party" && relativeRoot.split("/")[0] === "external") continue;
    const frontmatter = parseFrontmatter(fs.readFileSync(instructionPath, "utf8"));
    const name = frontmatter.name || path.basename(hostRoot);
    if (!name || !frontmatter.description) continue;
    const sandboxRoot = `${(config.sandboxRoot ?? "/home/alice/.agents/skills").replace(/\/+$/, "")}/${name}`;
    found.push({
      id: relativeRoot || name,
      name,
      description: frontmatter.description,
      version: frontmatter.version,
      allowedTools: frontmatter.allowedTools,
      disableModelInvocation: frontmatter.disableModelInvocation,
      userInvocable: frontmatter.userInvocable,
      disabled: frontmatter.disabled,
      unsupported: unsupportedFeature(frontmatter),
      hostRoot,
      instructionPath,
      sandboxRoot,
      source: config.source
    });
  }
  return found;
}

function findSkillFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...findSkillFiles(fullPath));
    if (entry.isFile() && entry.name === "SKILL.md") files.push(fullPath);
  }
  return files;
}

type SkillFrontmatter = {
  name?: string;
  description?: string;
  version?: string;
  allowedTools?: string[];
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  disabled?: boolean;
  context?: string;
  dynamicContext?: boolean;
};

function parseFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  const out: SkillFrontmatter = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const keyValue = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyValue) continue;
    const key = keyValue[1];
    const value = keyValue[2].trim();
    if (key === "name") out.name = unquote(value);
    if (key === "version") out.version = unquote(value);
    if (key === "description") {
      if (value === ">") {
        const block: string[] = [];
        while (lines[index + 1]?.startsWith("  ")) block.push(lines[++index].trim());
        out.description = block.join(" ").trim();
      } else {
        out.description = unquote(value);
      }
    }
    if (key === "allowed-tools") out.allowedTools = parseStringList(value);
    if (key === "disable-model-invocation") out.disableModelInvocation = parseBoolean(value);
    if (key === "user-invocable") out.userInvocable = parseBoolean(value);
    if (key === "disabled") out.disabled = parseBoolean(value);
    if (key === "context") out.context = unquote(value);
    if (key === "dynamic-context") out.dynamicContext = parseBoolean(value);
  }
  return out;
}

function unsupportedFeature(frontmatter: SkillFrontmatter): SkillMetadata["unsupported"] {
  if (frontmatter.context === "fork") return "fork";
  if (frontmatter.dynamicContext) return "dynamic-context";
  return undefined;
}

function parseStringList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map((entry) => unquote(entry.trim())).filter(Boolean);
  }
  return [unquote(trimmed)];
}

function parseBoolean(value: string): boolean {
  return value === "true";
}

function unquote(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function duplicated(values: string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return duplicates;
}

function isInside(value: string, root: string): boolean {
  const relative = path.relative(root, value);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
