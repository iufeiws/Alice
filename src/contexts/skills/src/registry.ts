const fs = await import("node:fs");
const path = await import("node:path");

export type SkillMetadata = {
  id: string;
  name: string;
  description: string;
  hostRoot: string;
  instructionPath: string;
  containerRoot: string;
};

export type SkillRegistry = {
  list(): SkillMetadata[];
  get(idOrName: string): SkillMetadata | undefined;
};

export function createSkillRegistry(input: { root: string; containerRoot: string }): SkillRegistry {
  const skills = scanSkills(input.root, input.containerRoot);
  return {
    list: () => [...skills],
    get(idOrName) {
      return skills.find((skill) => skill.id === idOrName || skill.name === idOrName);
    }
  };
}

function scanSkills(root: string, containerRoot: string): SkillMetadata[] {
  if (!fs.existsSync(root)) return [];
  const found: SkillMetadata[] = [];
  for (const instructionPath of findSkillFiles(root)) {
    const hostRoot = path.dirname(instructionPath);
    const relativeRoot = path.relative(root, hostRoot).split(path.sep).join("/");
    const frontmatter = parseFrontmatter(fs.readFileSync(instructionPath, "utf8"));
    const name = frontmatter.name || path.basename(hostRoot);
    found.push({
      id: relativeRoot || name,
      name,
      description: frontmatter.description || "",
      hostRoot,
      instructionPath,
      containerRoot: `${containerRoot.replace(/\/+$/, "")}/${relativeRoot}`.replace(/\/+$/, "")
    });
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
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

function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  const out: { name?: string; description?: string } = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const keyValue = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyValue) continue;
    if (keyValue[1] === "name") out.name = unquote(keyValue[2].trim());
    if (keyValue[1] === "description") {
      if (keyValue[2].trim() === ">") {
        const block: string[] = [];
        while (lines[index + 1]?.startsWith("  ")) block.push(lines[++index].trim());
        out.description = block.join(" ").trim();
      } else {
        out.description = unquote(keyValue[2].trim());
      }
    }
  }
  return out;
}

function unquote(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}
