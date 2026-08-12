import type { BashSandboxConfig } from "./config.js";

const childProcess = await import("node:child_process");

export type SandboxNotesEntry = {
  name: string;
  description: string;
  path: string;
};

/**
 * 同步读取沙箱容器内笔记目录的索引（每条笔记的 name / description / path）。
 * 供 prompt 变量在 skill 加载时直接构建列表，不需要 LLM 再执行命令。
 * 命令为固定字符串（目录来自配置），文件名 glob 在容器内展开，无宿主侧注入面。
 */
export function readSandboxNotesIndex(config: BashSandboxConfig, notesContainerDir: string): SandboxNotesEntry[] {
  const script = [
    `cd '${notesContainerDir}' 2>/dev/null || exit 0`,
    "for f in *.md; do",
    '  [ -f "$f" ] || continue',
    "  printf '@@%s\\n' \"$f\"",
    "  sed -n '1,/^---$/p' \"$f\"",
    "done"
  ].join("\n");
  const stdout = childProcess.execFileSync("docker", ["exec", config.containerName, "sh", "-c", script], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return parseSandboxNotesOutput(stdout, notesContainerDir);
}

export function parseSandboxNotesOutput(output: string, notesContainerDir: string): SandboxNotesEntry[] {
  const blocks: { file: string; lines: string[] }[] = [];
  let current: { file: string; lines: string[] } | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      current = { file: line.slice(2), lines: [] };
      blocks.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return blocks.map(({ file, lines }) => {
    const frontmatter = frontmatterBlock(lines);
    const name = frontmatterValue(frontmatter, "name") || file.replace(/\.md$/i, "");
    const description = frontmatterValue(frontmatter, "description") || "";
    return { name, description, path: `${notesContainerDir}/${file}` };
  });
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
