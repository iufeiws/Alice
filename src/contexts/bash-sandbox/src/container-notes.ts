import type { BashSandboxConfig } from "./config.js";
import { resolveSandboxHostPath } from "./paths.js";

const fs = await import("node:fs");
const path = await import("node:path");

export type SandboxNotesEntry = {
  name: string;
  description: string;
  path: string;
};

/**
 * 同步读取映射到沙箱容器内笔记目录的索引（每条笔记的 name / description / path）。
 * 笔记目录是宿主挂载目录，无须启动容器即可读取；返回路径仍是容器路径，供 Agent 使用。
 */
export function readSandboxNotesIndex(config: BashSandboxConfig, notesContainerDir: string): SandboxNotesEntry[] {
  const notesHostDir = resolveSandboxHostPath(config, notesContainerDir);
  if (!notesHostDir) throw new Error(`sandbox notes directory is not mounted: ${notesContainerDir}`);
  const files = readMarkdownFiles(notesHostDir);
  return files.map((file) => {
    const frontmatter = frontmatterBlock(fs.readFileSync(path.join(notesHostDir, file), "utf8").split(/\r?\n/));
    const name = frontmatterValue(frontmatter, "name") || file.replace(/\.md$/i, "");
    const description = frontmatterValue(frontmatter, "description") || "";
    return { name, description, path: `${notesContainerDir}/${file}` };
  });
}

function readMarkdownFiles(directory: string): string[] {
  try {
    return fs.readdirSync(directory)
      .filter((file) => file.endsWith(".md"))
      .filter((file) => fs.statSync(path.join(directory, file)).isFile())
      .sort();
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function frontmatterBlock(lines: string[]): string[] {
  if (lines[0]?.trim() !== "---") return [];
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return end >= 0 ? lines.slice(1, end) : [];
}

function frontmatterValue(lines: string[], key: string): string {
  const pattern = new RegExp(`^${key}:\\s*(.*)$`);
  for (const line of lines) {
    const match = line.match(pattern);
    if (match) return unquote(match[1].trim());
  }
  return "";
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
