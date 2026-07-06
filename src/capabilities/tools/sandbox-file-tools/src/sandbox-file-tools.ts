import type { BashSandboxConfig, BashSandboxRuntime } from "../../../../contexts/bash-sandbox/src/index.js";
import { isAllowedCwd, normalizeContainerPath } from "../../../../contexts/bash-sandbox/src/paths.js";
import type { ToolCall, ToolDefinition, ToolPlugin, ToolResult } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import { createOpenAICompatibleClient } from "../../../../contexts/llm-gateway/src/index.js";
import { createPromptApiPresetStore } from "../../../../contexts/llm-gateway/src/llm-api-profile.js";
import { readImageRecognitionConfig, recognizeImageWithPlugin } from "../../../../channels/image-recognition/src/index.js";

const path = await import("node:path");

const defaultMaxSizeBytes = 256 * 1024;
const defaultMaxImageSizeBytes = 10 * 1024 * 1024;
const defaultMaxOutputTokens = 25_000;
const fileUnchangedStub = "File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.";
const promptApiPresetStore = createPromptApiPresetStore("memory-files");

type ReadState = {
  content: string;
  timestamp: number;
  offset?: number;
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

type SandboxReadBase64Output = {
  type: "base64";
  file: {
    filePath: string;
    content: string;
  };
  meta?: {
    mtimeMs?: number;
    totalBytes?: number;
    readBytes?: number;
  };
};

type SandboxEditOutput = {
  type: "edit";
  file: {
    filePath: string;
    content: string;
  };
  meta?: {
    mtimeMs?: number;
  };
  message: string;
};

type SandboxSearchOutput = {
  type: "glob" | "grep";
  content: string;
};

export function createSandboxFileTools(input: { runtime: BashSandboxRuntime; config: BashSandboxConfig }): ToolPlugin {
  const readFileState = new Map<string, ReadState>();
  return {
    id: "sandbox-file-tools",
    listTools() {
      return [readTool, editTool, globTool, grepTool];
    },
    async execute(call) {
      try {
        if (call.toolName === "Read") return await readSandboxFile(call);
        if (call.toolName === "Edit") return await editSandboxFile(call);
        if (call.toolName === "Glob") return await searchSandboxFiles(call, "Glob");
        if (call.toolName === "Grep") return await searchSandboxFiles(call, "Grep");
        return toolError(call, `Unknown sandbox file tool: ${call.toolName}`);
      } catch (error) {
        return toolError(call, error instanceof Error ? error.message : String(error));
      }
    }
  };

  async function readSandboxFile(call: ToolCall): Promise<ToolResult> {
    const rawOffset = call.input.offset;
    const rawLimit = call.input.limit;
    const filePath = normalizeReadPath(requiredString(call.input.file_path, "file_path"));
    if (!isAllowedCwd(input.config, filePath)) throw new Error(`path is outside configured sandbox paths: ${filePath}`);
    if (isSupportedImageFile(filePath)) return await readSandboxImageFile(call, filePath, rawOffset, rawLimit);
    validateNoBlockedBinary(filePath);
    const offset = nonNegativeInteger(rawOffset, 1);
    const limit = optionalPositiveInteger(rawLimit);
    const stateOffset = offset;
    const existing = getFeatureValue_CACHED_MAY_BE_STALE("tengu_read_dedup_killswitch", false) ? undefined : readFileState.get(filePath);
    if (existing && !existing.isPartialView && existing.offset !== undefined && existing.offset === stateOffset && existing.limit === limit) {
      const mtimeMs = await getFileModificationTimeAsync(filePath);
      if (mtimeMs === existing.timestamp) return { callId: call.id, ok: true, output: fileUnchangedStub };
    }

    const result = await input.runtime.runFileTool({
      toolName: "Read",
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
    const output = parseToolJson<SandboxReadTextOutput>(result, "Read");
    if (output.type !== "text") throw new Error(`unsupported Read output type: ${String((output as { type?: unknown }).type)}`);
    validateContentTokens(output.file.content);
    if (output.meta?.mtimeMs !== undefined) {
      readFileState.set(filePath, {
        content: output.file.content,
        timestamp: Math.floor(output.meta.mtimeMs),
        offset: stateOffset,
        limit
      });
    }
    return { callId: call.id, ok: true, output: formatReadToolResult(output.file) };
  }

  async function readSandboxImageFile(call: ToolCall, filePath: string, rawOffset: unknown, rawLimit: unknown): Promise<ToolResult> {
    if (rawOffset !== undefined || rawLimit !== undefined) throw new Error("offset and limit are not supported for image files");
    const result = await input.runtime.runFileTool({
      toolName: "Read",
      payload: {
        operation: "base64",
        file_path: filePath,
        max_size_bytes: defaultMaxImageSizeBytes,
        allowed_roots: allowedRoots(input.config),
        cwd: input.config.defaultCwd
      },
      outputLimitBytes: defaultMaxImageSizeBytes * 2
    });
    const output = parseToolJson<SandboxReadBase64Output>(result, "Read");
    if (output.type !== "base64") throw new Error(`unsupported Read output type: ${String((output as { type?: unknown }).type)}`);
    const config = readImageRecognitionConfig();
    const recognition = await recognizeImageWithPlugin({
      imageFile: Buffer.from(output.file.content, "base64"),
      filename: path.basename(filePath),
      mimeType: mimeTypeForImageFile(filePath)
    }, config, {
      resolveApiPreset(name) {
        return promptApiPresetStore.readLLMApiPresets().find((entry) => entry.name === name);
      },
      createLlmClientFromPreset(preset) {
        if (!preset.baseURL || !preset.apiKey) return undefined;
        return createOpenAICompatibleClient({
          baseURL: preset.baseURL,
          apiKey: preset.apiKey,
          model: preset.model,
          temperature: preset.temperature,
          timeoutMs: preset.timeoutMs,
          extraParams: preset.extraParams
        });
      },
      async llmRequestSender(request) {
        if (!request.client) throw new Error("missing_image_recognition_client");
        return await request.client.chat({
          messages: request.messages,
          model: request.model,
          temperature: request.temperature,
          maxTokens: request.maxTokens,
          extraParams: request.extraParams,
          signal: request.signal
        });
      }
    });
    if ("ok" in recognition) throw new Error(recognition.error);
    return { callId: call.id, ok: true, output: `Image recognition result:\n${recognition.text}` };
  }

  async function editSandboxFile(call: ToolCall): Promise<ToolResult> {
    const filePath = normalizeReadPath(requiredString(call.input.file_path, "file_path"));
    if (!isAllowedCwd(input.config, filePath)) throw new Error(`path is outside configured sandbox paths: ${filePath}`);
    const result = await input.runtime.runFileTool({
      toolName: "Edit",
      payload: {
        file_path: filePath,
        old_string: requiredStringValue(call.input.old_string, "old_string"),
        new_string: requiredStringValue(call.input.new_string, "new_string"),
        ...(call.input.replace_all !== undefined ? { replace_all: booleanValue(call.input.replace_all, "replace_all") } : {}),
        read_state: readFileState.get(filePath),
        allowed_roots: allowedRoots(input.config),
        cwd: input.config.defaultCwd
      },
      outputLimitBytes: defaultMaxSizeBytes * 3
    });
    const output = parseToolJson<SandboxEditOutput>(result, "Edit");
    if (output.type !== "edit") throw new Error(`unsupported Edit output type: ${String((output as { type?: unknown }).type)}`);
    if (output.meta?.mtimeMs !== undefined) {
      readFileState.set(filePath, {
        content: output.file.content,
        timestamp: Math.floor(output.meta.mtimeMs),
        offset: undefined,
        limit: undefined
      });
    }
    return { callId: call.id, ok: true, output: "OK" };
  }

  async function searchSandboxFiles(call: ToolCall, toolName: "Glob" | "Grep"): Promise<ToolResult> {
    const payload: Record<string, unknown> = {
      ...call.input,
      pattern: requiredString(call.input.pattern, "pattern"),
      allowed_roots: allowedRoots(input.config),
      cwd: input.config.defaultCwd
    };
    if (call.input.path !== undefined) {
      const searchPath = normalizeReadPath(requiredString(call.input.path, "path"));
      if (!isAllowedCwd(input.config, searchPath)) throw new Error(`path is outside configured sandbox paths: ${searchPath}`);
      payload.path = searchPath;
    }
    const result = await input.runtime.runFileTool({ toolName, payload, outputLimitBytes: defaultMaxSizeBytes * 3 });
    const output = parseToolJson<SandboxSearchOutput>(result, toolName);
    if (output.type !== toolName.toLowerCase()) throw new Error(`unsupported ${toolName} output type: ${String((output as { type?: unknown }).type)}`);
    return { callId: call.id, ok: true, output: output.content };
  }

  async function getFileModificationTimeAsync(filePath: string): Promise<number> {
    const result = await input.runtime.runFileTool({
      toolName: "Read",
      payload: {
        operation: "mtime",
        file_path: filePath,
        allowed_roots: allowedRoots(input.config),
        cwd: input.config.defaultCwd
      },
      outputLimitBytes: 8192
    });
    const output = parseToolJson<SandboxReadMtimeOutput>(result, "Read");
    if (output.type !== "mtime") throw new Error(`unsupported Read output type: ${String((output as { type?: unknown }).type)}`);
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

export const editTool: ToolDefinition = {
  name: "Edit",
  description: "Performs exact string replacements in a sandbox file.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file to modify inside the sandbox." },
      old_string: { type: "string", description: "The text to replace." },
      new_string: { type: "string", description: "The text to replace it with." },
      replace_all: { type: "boolean", description: "Replace all occurrences of old_string." }
    },
    required: ["file_path", "old_string", "new_string"],
    additionalProperties: false
  }
};

export const globTool: ToolDefinition = {
  name: "Glob",
  description: "Finds files by glob pattern in the configured sandbox.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The glob pattern to match files against." },
      path: { type: "string", description: "Optional absolute sandbox directory path to search in." }
    },
    required: ["pattern"],
    additionalProperties: false
  }
};

export const grepTool: ToolDefinition = {
  name: "Grep",
  description: "Searches file contents with ripgrep in the configured sandbox.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The regular expression pattern to search for in file contents." },
      path: { type: "string", description: "Optional absolute sandbox file or directory path to search in." },
      glob: { type: "string", description: "Optional glob pattern to filter files." },
      output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "Output mode. Defaults to files_with_matches." },
      "-B": { type: "number", description: "Number of lines to show before each match for content output." },
      "-A": { type: "number", description: "Number of lines to show after each match for content output." },
      "-C": { type: "number", description: "Alias for context." },
      context: { type: "number", description: "Number of lines to show before and after each match for content output." },
      "-n": { type: "boolean", description: "Show line numbers in content output. Defaults to true." },
      "-i": { type: "boolean", description: "Case insensitive search." },
      type: { type: "string", description: "Ripgrep file type filter." },
      head_limit: { type: "number", description: "Limit output to first N lines or entries. Defaults to 250; pass 0 for unlimited." },
      offset: { type: "number", description: "Skip first N lines or entries before applying head_limit." },
      multiline: { type: "boolean", description: "Enable multiline mode." }
    },
    required: ["pattern"],
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

function parseToolJson<T>(result: Awaited<ReturnType<BashSandboxRuntime["runFileTool"]>>, toolName: string): T {
  if (result.timedOut) throw new Error(`${toolName} timed out`);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${toolName} exited with status ${result.exitCode}`);
  return JSON.parse(result.stdout) as T;
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

function isSupportedImageFile(filePath: string): boolean {
  return supportedImageExtensions.has(path.extname(filePath).toLowerCase());
}

function mimeTypeForImageFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

const supportedImageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

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

function requiredStringValue(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} is required`);
  return value;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
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
