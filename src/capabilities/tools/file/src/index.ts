import type { BashSandboxConfig, BashSandboxRuntime } from "../../../../contexts/bash-sandbox/src/index.js";
import { isAllowedCwd, normalizeContainerPath } from "../../../../contexts/bash-sandbox/src/paths.js";
import type { ToolCall, ToolDefinition, ToolExecutionContext, ToolPlugin, ToolResult } from "../../../../contexts/agent-loop/src/contracts/agent-contracts.js";
import type { PiContent, PiWorkerRuntime } from "../../../../contexts/pi-worker/src/index.js";
import { piToolResultToToolResult } from "../../../../contexts/pi-worker/src/index.js";
import type { ImageRecognitionTarget } from "../../../../channels/image-recognition/src/index.js";
import { editTool, globTool, piFileToolNames, readTool, writeTool } from "../profile.js";

const defaultMaxSizeBytes = 256 * 1024;

type SandboxSearchOutput = {
  type: "glob";
  content: string;
};

export function createFileTools(input: {
  bashSandbox?: BashSandboxRuntime;
  config?: BashSandboxConfig;
  piWorker?: PiWorkerRuntime;
  recognizeImage?(target: ImageRecognitionTarget): Promise<{ text: string }>;
}): ToolPlugin {
  return {
    id: "file",
    listTools(): ToolDefinition[] {
      const tools: ToolDefinition[] = input.piWorker ? [readTool, writeTool, editTool] : [];
      if (input.bashSandbox && input.config) tools.push(globTool);
      return tools;
    },
    async execute(call, context): Promise<ToolResult> {
      if (call.toolName === "Read" || call.toolName === "Write" || call.toolName === "Edit") {
        if (!input.piWorker) throw new Error(`file_tool_unavailable:${call.toolName}`);
        const result = await input.piWorker.executeTool({
          requestId: call.id,
          toolName: piFileToolNames[call.toolName],
          input: call.input,
          context
        });
        return await fileToolResult(call, result, context, input.recognizeImage);
      }
      if (call.toolName === "Glob") {
        if (!input.bashSandbox || !input.config) throw new Error(`file_tool_unavailable:${call.toolName}`);
        return await searchSandboxFiles(call, input.bashSandbox, input.config);
      }
      throw new Error(`file_tool_unavailable:${call.toolName}`);
    }
  };
}

async function fileToolResult(
  call: ToolCall,
  result: Awaited<ReturnType<PiWorkerRuntime["executeTool"]>>,
  context: ToolExecutionContext | undefined,
  recognizeImage?: (target: ImageRecognitionTarget) => Promise<{ text: string }>
): Promise<ToolResult> {
  const imageContent = result.content?.filter((part) => part.type === "image") ?? [];
  if (result.ok && imageContent.length > 0) {
    if (context?.llmCapabilities?.supportsImage === true) {
      return {
        ...piToolResultToToolResult(call.id, result),
        llmFollowupAttachments: imageContent.map((part) => ({
          kind: "image" as const,
          data: part.data,
          mime: part.mimeType
        }))
      };
    }
    return await convertImages(call, result.content!, recognizeImage);
  }
  return piToolResultToToolResult(call.id, result);
}

async function convertImages(call: ToolCall, content: PiContent[], recognizeImage?: (target: ImageRecognitionTarget) => Promise<{ text: string }>): Promise<ToolResult> {
  if (!recognizeImage) throw new Error("file_read_image_recognition_required");
  const texts: string[] = [];
  for (const part of content) {
    if (part.type === "text") texts.push(part.text);
    else texts.push((await recognizeImage({ data: part.data, mimeType: part.mimeType })).text);
  }
  return { callId: call.id, ok: true, output: texts.join("\n") };
}

async function searchSandboxFiles(call: ToolCall, runtime: BashSandboxRuntime, config: BashSandboxConfig): Promise<ToolResult> {
  const payload: Record<string, unknown> = {
    ...call.input,
    pattern: requiredString(call.input.pattern, "pattern"),
    allowed_roots: allowedRoots(config),
    cwd: config.defaultCwd
  };
  if (call.input.path !== undefined) {
    const searchPath = normalizeReadPath(requiredString(call.input.path, "path"));
    if (!isAllowedCwd(config, searchPath)) throw new Error(`path is outside configured sandbox paths: ${searchPath}`);
    payload.path = searchPath;
  }
  const result = await runtime.runFileTool({ toolName: "Glob", payload, outputLimitBytes: defaultMaxSizeBytes * 3 });
  const output = parseToolJson<SandboxSearchOutput>(result, "Glob");
  if (output.type !== "glob") throw new Error(`unsupported Glob output type: ${String((output as { type?: unknown }).type)}`);
  return { callId: call.id, ok: true, output: output.content };
}

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

function normalizeReadPath(value: string): string {
  const normalized = normalizeContainerPath(value, "/");
  if (!normalized || !normalized.startsWith("/")) throw new Error("path must be an absolute sandbox path");
  return normalized;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}
