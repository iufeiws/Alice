import type { ToolCall, ToolDefinition, ToolPlugin, ToolResult } from "../../../contexts/agent-loop/src/contracts/agent-contracts.js";

const fs = await import("node:fs");
const fsp = await import("node:fs/promises");
const path = await import("node:path");
const childProcess = await import("node:child_process");
const crypto = await import("node:crypto");

export type WorkspaceVirtualFile = {
  read(): string;
  write(content: string): void;
  version?(): string;
};

export type WorkspaceFilesToolsDeps = {
  root?: string;
  virtualFiles?: Map<string, WorkspaceVirtualFile>;
};

export type WorkspaceFilesToolPlugin = ToolPlugin & {
  resolveFilePath(filePath: string): string;
  primeRead(filePath: string): Promise<string>;
};

const defaultReadLimit = 2000;
const maxGlobResults = 100;

const readTool: ToolDefinition = {
  name: "Read",
  description: [
    "Reads a file from the local workspace.",
    "The file_path parameter must be a workspace-relative path.",
    "Returns content with cat -n style line numbers. Use offset and limit to page through large files."
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Workspace-relative path to the file to read." },
      offset: { type: "number", description: "Optional 1-based line number to start reading from." },
      limit: { type: "number", description: "Optional maximum number of lines to read." }
    },
    required: ["file_path"],
    additionalProperties: false
  }
};

const editTool: ToolDefinition = {
  name: "Edit",
  description: [
    "Performs exact string replacements in a workspace file.",
    "The file must have been read with Read in this session before editing.",
    "old_string must match exactly. By default it must match exactly once; use replace_all only when every match should be replaced."
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Workspace-relative path to the file to modify." },
      old_string: { type: "string", description: "Exact text to replace." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace all occurrences of old_string." }
    },
    required: ["file_path", "old_string", "new_string"],
    additionalProperties: false
  }
};

const globTool: ToolDefinition = {
  name: "Glob",
  description: [
    "Finds workspace files by glob pattern.",
    "Supports ** for recursive matching. Results are sorted by modification time descending."
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern such as **/*.ts." },
      path: { type: "string", description: "Optional workspace-relative directory path to search from." }
    },
    required: ["pattern"],
    additionalProperties: false
  }
};

const grepTool: ToolDefinition = {
  name: "Grep",
  description: [
    "Searches file contents in the workspace using ripgrep.",
    "Defaults to files_with_matches. Use output_mode=content for matching lines or output_mode=count for per-file counts."
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression pattern to search for." },
      path: { type: "string", description: "Optional workspace-relative file or directory path to search." },
      glob: { type: "string", description: "Optional glob filter passed to ripgrep." },
      type: { type: "string", description: "Optional ripgrep file type filter, such as ts or js." },
      output_mode: { type: "string", enum: ["files_with_matches", "content", "count"], default: "files_with_matches" },
      multiline: { type: "boolean", description: "Enable ripgrep multiline mode." }
    },
    required: ["pattern"],
    additionalProperties: false
  }
};

export function createWorkspaceFilesTools(deps: WorkspaceFilesToolsDeps = {}): WorkspaceFilesToolPlugin {
  const root = path.resolve(deps.root ?? process.cwd());
  const virtualFiles = deps.virtualFiles ?? new Map<string, WorkspaceVirtualFile>();
  const readSnapshots = new Map<string, string>();

  const plugin: WorkspaceFilesToolPlugin = {
    id: "workspace-files",
    listTools() {
      return [readTool, editTool, globTool, grepTool];
    },
    async execute(call) {
      try {
        if (call.toolName === "Read") return await readWorkspaceFile(call);
        if (call.toolName === "Edit") return await editWorkspaceFile(call);
        if (call.toolName === "Glob") return await globWorkspaceFiles(call);
        if (call.toolName === "Grep") return grepWorkspaceFiles(call);
        return toolError(call, `Unknown workspace file tool: ${call.toolName}`);
      } catch (error) {
        return toolError(call, error instanceof Error ? error.message : String(error));
      }
    },
    resolveFilePath(filePath) {
      return resolveWorkspacePath(filePath, root);
    },
    async primeRead(filePath) {
      const resolved = resolveWorkspacePath(filePath, root);
      const content = await readWorkspaceContent(resolved);
      readSnapshots.set(resolved, contentFingerprint(resolved, content));
      return content;
    }
  };

  return plugin;

  async function readWorkspaceFile(call: ToolCall): Promise<ToolResult> {
    const filePath = requiredString(call.input.file_path, "file_path");
    const resolved = resolveWorkspacePath(filePath, root);
    const content = await readWorkspaceContent(resolved);
    readSnapshots.set(resolved, contentFingerprint(resolved, content));
    const offset = positiveInteger(call.input.offset, 1);
    const limit = positiveInteger(call.input.limit, defaultReadLimit);
    return {
      callId: call.id,
      ok: true,
      output: formatReadOutput(content, { offset, limit })
    };
  }

  async function editWorkspaceFile(call: ToolCall): Promise<ToolResult> {
    const filePath = requiredString(call.input.file_path, "file_path");
    const oldString = requiredString(call.input.old_string, "old_string");
    const newString = requiredString(call.input.new_string, "new_string");
    const replaceAll = call.input.replace_all === true;
    const resolved = resolveWorkspacePath(filePath, root);
    const current = await readWorkspaceContent(resolved);
    const fingerprint = contentFingerprint(resolved, current);
    const previous = readSnapshots.get(resolved);
    if (!previous) return toolError(call, "File must be read with Read before Edit");
    if (previous !== fingerprint) return toolError(call, "File has changed since it was last read");
    if (oldString.length === 0 && current.length > 0) return toolError(call, "old_string can be empty only when editing an empty file");

    const matches = oldString.length === 0 ? (current.length === 0 ? 1 : 0) : countOccurrences(current, oldString);
    if (matches === 0) return toolError(call, editNotFoundError(current, oldString));
    if (!replaceAll && matches > 1) {
      return toolError(call, `old_string appears ${matches} times; include more surrounding context to identify one occurrence or use replace_all to replace every occurrence`);
    }

    const next = oldString.length === 0
      ? newString
      : replaceAll
        ? current.split(oldString).join(newString)
        : current.replace(oldString, newString);
    await writeWorkspaceContent(resolved, next);
    readSnapshots.set(resolved, contentFingerprint(resolved, next));
    return {
      callId: call.id,
      ok: true,
      output: `The file ${displayPath(resolved, root)} has been updated.`
    };
  }

  async function globWorkspaceFiles(call: ToolCall): Promise<ToolResult> {
    const pattern = requiredString(call.input.pattern, "pattern");
    const base = call.input.path === undefined
      ? root
      : resolveWorkspacePath(requiredString(call.input.path, "path"), root);
    const stat = await fsp.stat(base).catch(() => undefined);
    if (!stat?.isDirectory()) return toolError(call, "path must be a directory inside the workspace");

    const matchers = expandBraces(pattern).map(globToRegExp);
    const files = await collectFiles(base);
    const matches = files
      .map((filePath) => {
        const relative = toPosix(path.relative(base, filePath));
        return { filePath, relative };
      })
      .filter((entry) => matchers.some((matcher) => matcher.test(entry.relative)))
      .map((entry) => {
        const stat = fs.statSync(entry.filePath) as { mtimeMs?: number; mtime?: Date };
        return { ...entry, mtimeMs: stat.mtimeMs ?? stat.mtime?.getTime() ?? 0 };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    const visible = matches.slice(0, maxGlobResults).map((entry) => displayPath(entry.filePath, root));
    const suffix = matches.length > maxGlobResults ? `\n\nResults truncated to ${maxGlobResults} of ${matches.length} matches.` : "";
    return {
      callId: call.id,
      ok: true,
      output: visible.length > 0 ? `${visible.join("\n")}${suffix}` : "No files found"
    };
  }

  function grepWorkspaceFiles(call: ToolCall): ToolResult {
    const pattern = requiredString(call.input.pattern, "pattern");
    const searchPath = call.input.path === undefined
      ? root
      : resolveWorkspacePath(requiredString(call.input.path, "path"), root);
    const outputMode = stringValue(call.input.output_mode) || "files_with_matches";
    if (!["files_with_matches", "content", "count"].includes(outputMode)) return toolError(call, "unsupported output_mode");
    const searchIsFile = isFilePath(searchPath);
    const args = ["--color", "never"];
    if (outputMode === "files_with_matches") args.push("--files-with-matches");
    if (outputMode === "count") args.push("--count");
    if (outputMode === "content") args.push("--line-number");
    if (call.input.multiline === true) {
      args.push("--multiline");
      args.push("--multiline-dotall");
    }
    const glob = stringValue(call.input.glob);
    if (glob) args.push("--glob", glob);
    const type = stringValue(call.input.type);
    if (type) args.push("--type", type);
    const rootIgnore = path.join(root, ".gitignore");
    if (!searchIsFile && fs.existsSync(rootIgnore)) {
      args.push("--ignore-file", rootIgnore);
      for (const pattern of readSimpleGitignorePatterns(rootIgnore)) args.push("--glob", `!${pattern}`);
    }
    if (searchIsFile) args.push("--no-ignore");
    const searchArg = toPosix(path.relative(root, searchPath)) || ".";
    args.push(pattern, searchArg);

    const result = childProcess.spawnSync("rg", args, { cwd: root, encoding: "utf8" });
    if (result.error) return toolError(call, `rg failed: ${result.error.message}`);
    if (result.status === 1) return { callId: call.id, ok: true, output: "No matches found" };
    if (result.status !== 0) return toolError(call, result.stderr?.trim() || `rg exited with status ${result.status}`);
    return { callId: call.id, ok: true, output: formatGrepOutput(result.stdout.trimEnd()) || "No matches found" };
  }

  async function readWorkspaceContent(resolved: string): Promise<string> {
    const virtual = virtualFiles.get(resolved);
    if (virtual) return virtual.read();
    const stat = await fsp.stat(resolved).catch(() => undefined);
    if (!stat) throw new Error("file not found");
    if (!stat.isFile()) throw new Error("path must point to a file");
    return await fsp.readFile(resolved, "utf8");
  }

  async function writeWorkspaceContent(resolved: string, content: string): Promise<void> {
    const virtual = virtualFiles.get(resolved);
    if (virtual) {
      virtual.write(content);
      return;
    }
    await fsp.writeFile(resolved, content, "utf8");
  }

  function contentFingerprint(resolved: string, content: string): string {
    const virtual = virtualFiles.get(resolved);
    const version = virtual?.version?.();
    return version ? `virtual:${version}` : crypto.createHash("sha256").update(content).digest("hex");
  }
}

export function formatReadOutput(content: string, options: { offset?: number; limit?: number } = {}): string {
  if (content.length === 0) return "File is empty.";
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  const offset = Math.max(1, Math.floor(options.offset ?? 1));
  const limit = Math.max(1, Math.floor(options.limit ?? defaultReadLimit));
  const startIndex = offset - 1;
  const selected = lines.slice(startIndex, startIndex + limit);
  if (selected.length === 0) return `No lines found at offset ${offset}. File has ${lines.length} line(s).`;
  const width = String(startIndex + selected.length).length;
  const body = selected
    .map((line, index) => `${String(startIndex + index + 1).padStart(Math.max(6, width), " ")}\t${line}`)
    .join("\n");
  const nextLine = startIndex + selected.length + 1;
  const suffix = nextLine <= lines.length ? `\n\n[Showing lines ${offset}-${nextLine - 1} of ${lines.length}. Use offset=${nextLine} to continue.]` : "";
  return `${body}${suffix}`;
}

function resolveWorkspacePath(filePath: string, root: string): string {
  if (path.isAbsolute(filePath)) throw new Error("path must be workspace-relative");
  if (filePath.startsWith(`.${path.sep}`) || filePath.startsWith(`./`) || filePath.startsWith(`.\\`)) {
    throw new Error("path is outside the workspace");
  }
  const resolved = path.resolve(root, filePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("path is outside the workspace");
  return resolved;
}

function displayPath(filePath: string, root: string): string {
  const relative = toPosix(path.relative(root, filePath));
  return relative || ".";
}

function formatGrepOutput(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.replace(/\\/g, "/").replace(/^\.\//u, ""))
    .join("\n");
}

async function collectFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile()) output.push(fullPath);
    }
  }
  await walk(root);
  return output;
}

function globToRegExp(pattern: string): RegExp {
  const normalized = toPosix(pattern);
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      const after = normalized[index + 2];
      if (after === "/") {
        source += "(?:.*\\/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`${source}$`, "u");
}

function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]+)\}/u.exec(pattern);
  if (!match) return [pattern];
  const [token, body] = match;
  const before = pattern.slice(0, match.index);
  const after = pattern.slice(match.index + token.length);
  return body.split(",").flatMap((part) => expandBraces(`${before}${part}${after}`));
}

function editNotFoundError(content: string, oldString: string): string {
  const diagnostics: string[] = ["old_string not found in file"];
  if (oldString.includes("\n") || oldString.includes("\r")) {
    const normalizedOld = normalizeLineEndings(oldString);
    if (normalizeLineEndings(content).includes(normalizedOld)) diagnostics.push("possible line ending mismatch: old_string differs only after CRLF/LF normalization");
  }
  const trimmedOld = trimLineEndWhitespace(oldString);
  if (trimLineEndWhitespace(content).includes(trimmedOld) || content.includes(oldString.trim())) {
    diagnostics.push("possible whitespace mismatch: check leading, trailing, or line-end spaces in old_string");
  }
  const compactOld = normalizeWhitespace(oldString);
  if (normalizeWhitespace(content).includes(compactOld)) {
    diagnostics.push("possible whitespace-normalized match: spacing or indentation differs from the file");
  }
  const unicodeOld = oldString.normalize("NFC");
  if (content.normalize("NFC").includes(unicodeOld) && content.includes(oldString) === false) {
    diagnostics.push("possible Unicode normalization mismatch: old_string matches after NFC normalization");
  }
  diagnostics.push("No edit was applied. Re-read the file and provide an exact old_string with enough surrounding context.");
  return diagnostics.join("\n");
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function trimLineEndWhitespace(value: string): string {
  return value.replace(/[ \t]+$/gm, "");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function isFilePath(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readSimpleGitignorePatterns(filePath: string): string[] {
  try {
    return fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"))
      .map((line) => line.startsWith("/") ? line.slice(1) : line);
  } catch {
    return [];
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (index <= text.length) {
    const found = text.indexOf(needle, index);
    if (found < 0) return count;
    count += 1;
    index = found + needle.length;
  }
  return count;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} is required`);
  return value;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function positiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function toolError(call: Pick<ToolCall, "id">, error: string): ToolResult {
  return { callId: call.id, ok: false, error };
}
