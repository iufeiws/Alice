import type { BashSandboxConfig, BashSandboxRuntime } from "../../../../contexts/bash-sandbox/src/index.js";
import { isAllowedCwd, normalizeContainerPath } from "../../../../contexts/bash-sandbox/src/paths.js";
import type { ToolCall, ToolDefinition, ToolPlugin, ToolResult } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";

const path = await import("node:path");

const defaultMaxSizeBytes = 256 * 1024;
const defaultMaxOutputTokens = 25_000;
const fileUnchangedStub = "File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.";

type ReadState = {
  content: string;
  timestamp: number;
  offset: number;
  limit?: number;
  isPartialView?: boolean;
};

type SandboxReadTextOutput = {
  type: "text";
  file: {
    filePath: string;
    content: string;
    numLines: number;
    startLine: number;
    totalLines: number;
  };
};

type SandboxReadInternalOutput = SandboxReadTextOutput & {
  meta?: {
    mtimeMs?: number;
    totalBytes?: number;
    readBytes?: number;
  };
};

type SandboxReadMtimeOutput = {
  type: "mtime";
  file: { filePath: string };
  mtimeMs: number;
};

export function createSandboxReadTools(input: { runtime: BashSandboxRuntime; config: BashSandboxConfig }): ToolPlugin {
  const readFileState = new Map<string, ReadState>();
  return {
    id: "sandbox-read",
    listTools() {
      return [readTool];
    },
    async execute(call) {
      if (call.toolName !== "Read") return toolError(call, `Unknown sandbox read tool: ${call.toolName}`);
      try {
        return await readSandboxFile(call);
      } catch (error) {
        return toolError(call, error instanceof Error ? error.message : String(error));
      }
    }
  };

  async function readSandboxFile(call: ToolCall): Promise<ToolResult> {
    const filePath = normalizeReadPath(requiredString(call.input.file_path, "file_path"));
    if (!isAllowedCwd(input.config, filePath)) throw new Error(`path is outside configured sandbox paths: ${filePath}`);
    validateNoBlockedBinary(filePath);
    const offset = nonNegativeInteger(call.input.offset, 1);
    const limit = optionalPositiveInteger(call.input.limit);
    const dedupKillswitch = getFeatureValue_CACHED_MAY_BE_STALE("tengu_read_dedup_killswitch", false);
    const existing = dedupKillswitch ? undefined : readFileState.get(filePath);
    if (existing && !existing.isPartialView && existing.offset !== undefined) {
      const rangeMatch = existing.offset === offset && existing.limit === limit;
      if (rangeMatch) {
        const mtimeMs = await getFileModificationTimeAsync(filePath);
        if (mtimeMs === existing.timestamp) {
          return { callId: call.id, ok: true, output: fileUnchangedStub };
        }
      }
    }

    const result = await input.runtime.readFile({
      payload: {
        file_path: filePath,
        offset,
        ...(limit !== undefined ? { limit } : {}),
        max_size_bytes: defaultMaxSizeBytes,
        allowed_roots: allowedRoots(input.config),
        cwd: input.config.defaultCwd
      },
      outputLimitBytes: defaultMaxSizeBytes * 3
    });
    const output = parseReadOutput(result);
    validateContentTokens(output.file.content);
    const mtimeMs = output.meta?.mtimeMs;
    if (mtimeMs !== undefined) readFileState.set(filePath, { content: output.file.content, timestamp: Math.floor(mtimeMs), offset, limit });
    return { callId: call.id, ok: true, output: formatReadToolResult(output.file) };
  }

  async function getFileModificationTimeAsync(filePath: string): Promise<number> {
    const result = await input.runtime.readFile({
      payload: {
        operation: "mtime",
        file_path: filePath,
        allowed_roots: allowedRoots(input.config),
        cwd: input.config.defaultCwd
      },
      outputLimitBytes: 8192
    });
    const output = parseMtimeOutput(result);
    return Math.floor(output.mtimeMs);
  }
}

export const readTool: ToolDefinition = {
  name: "Read",
  description: "Reads a text file from the configured sandbox by absolute sandbox path.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file to read inside the sandbox." },
      offset: { type: "number", description: "Optional 1-based line number to start reading from." },
      limit: { type: "number", description: "Optional number of lines to read." }
    },
    required: ["file_path"],
    additionalProperties: false
  }
};

function allowedRoots(config: BashSandboxConfig): string[] {
  return [
    config.workspaceDir,
    config.cacheDir,
    config.tmpDir,
    ...config.skillMounts.map((mount) => mount.containerPath),
    ...config.mounts.map((mount) => mount.containerPath)
  ];
}

function parseReadOutput(result: Awaited<ReturnType<BashSandboxRuntime["readFile"]>>): SandboxReadInternalOutput {
  if (result.timedOut) throw new Error("Read timed out");
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `Read exited with status ${result.exitCode}`);
  const output = JSON.parse(result.stdout) as SandboxReadInternalOutput;
  if (output.type !== "text") throw new Error(`unsupported Read output type: ${String((output as { type?: unknown }).type)}`);
  return output;
}

function parseMtimeOutput(result: Awaited<ReturnType<BashSandboxRuntime["readFile"]>>): SandboxReadMtimeOutput {
  if (result.timedOut) throw new Error("Read timed out");
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `Read exited with status ${result.exitCode}`);
  const output = JSON.parse(result.stdout) as SandboxReadMtimeOutput;
  if (output.type !== "mtime") throw new Error(`unsupported Read output type: ${String((output as { type?: unknown }).type)}`);
  return output;
}

function formatReadToolResult(file: SandboxReadTextOutput["file"]): string {
  if (file.content) return addLineNumbers(file);
  if (file.totalLines === 0) return "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>";
  return `<system-reminder>Warning: the file exists but is shorter than the provided offset (${file.startLine}). The file has ${file.totalLines} lines.</system-reminder>`;
}

function addLineNumbers(file: { content: string; startLine: number }): string {
  if (!file.content) return "";
  return file.content.split(/\r?\n/).map((line, index) => `${index + file.startLine}\t${line}`).join("\n");
}

function getFeatureValue_CACHED_MAY_BE_STALE(name: string, fallback: boolean): boolean {
  const value = process.env[name] ?? process.env[name.toUpperCase()];
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function normalizeReadPath(value: string): string {
  const normalized = normalizeContainerPath(value, "/");
  if (!normalized || !normalized.startsWith("/")) throw new Error("file_path must be an absolute sandbox path");
  return normalized;
}

function validateNoBlockedBinary(filePath: string): void {
  const ext = path.extname(filePath).toLowerCase();
  if (binaryExtensions.has(ext)) {
    throw new Error(`This tool cannot read binary files. The file appears to be a binary ${ext} file. Please use appropriate tools for binary file analysis.`);
  }
}

function validateContentTokens(content: string): void {
  const estimate = Math.ceil(content.length / 4);
  if (estimate > defaultMaxOutputTokens) {
    throw new Error(`File content (${estimate} tokens) exceeds maximum allowed tokens (${defaultMaxOutputTokens}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`);
  }
}

const binaryExtensions = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tiff", ".tif",
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".wmv", ".flv", ".m4v", ".mpeg", ".mpg",
  ".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a", ".wma", ".aiff", ".opus",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar", ".xz", ".z", ".tgz", ".iso",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a", ".obj", ".lib", ".app", ".msi", ".deb", ".rpm",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".pyc", ".pyo", ".class", ".jar", ".war", ".ear", ".node", ".wasm", ".rlib",
  ".sqlite", ".sqlite3", ".db", ".mdb", ".idx",
  ".psd", ".ai", ".eps", ".sketch", ".fig", ".xd", ".blend", ".3ds", ".max",
  ".swf", ".fla", ".lockb", ".dat", ".data"
]);

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("offset must be a non-negative integer");
  return Math.floor(value);
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error("limit must be a positive integer");
  return Math.floor(value);
}

function toolError(call: Pick<ToolCall, "id">, error: string): ToolResult {
  return { callId: call.id, ok: false, error };
}
