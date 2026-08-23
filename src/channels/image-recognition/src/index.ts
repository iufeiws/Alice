import type { LLMClient } from "../../../contexts/llm-gateway/src/index.js";
import type { LLMRequestSender } from "../../../contexts/llm-gateway/src/llm-tool-loop.js";
import type { PromptContextRuntime } from "../../../contexts/prompt-context/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

export const defaultImageRecognitionPrompt = "请详细描述这张图片的内容。";

export function defaultImageRecognitionExtraParams(): Record<string, unknown> {
  return {
    max_completion_tokens: 8192
  };
}

export type ImageRecognitionApiPreset = {
  name?: string;
  baseURL: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  timeoutMs?: number;
  useProxy?: boolean;
  stream?: boolean;
  extraParams?: Record<string, unknown>;
  followupExtraParams?: Record<string, unknown>;
};

export type ImageRecognitionConfig = {
  enabled: boolean;
  apiPresetName?: string;
  prompt?: string;
  extraParams?: Record<string, unknown>;
  testImagePath?: string;
};

export type ImageRecognitionInput = {
  imageFile: File | Blob | Uint8Array | string;
  filename?: string;
  mimeType?: string;
  prompt?: string;
  metadata?: Record<string, unknown>;
};

/**
 * 图片识别目标: 宿主文件路径, 或已编码的图像字节(base64 data + mimeType)。
 * 工具侧拿到 base64 时直接透传, 不落盘再读。
 */
export type ImageRecognitionTarget = string | { data: string; mimeType: string };

export type ImageRecognitionResult = {
  text: string;
  provider: "multimodal_llm";
  model?: string;
  durationMs?: number;
  requestId?: string;
  raw?: unknown;
};

export type ImageRecognitionError = {
  ok: false;
  error:
    | "image_recognition_disabled"
    | "missing_image_file"
    | "unsupported_image_format"
    | "missing_provider_config"
    | "provider_request_failed"
    | "empty_description";
  message?: string;
  requestId?: string;
};

export type ImageRecognitionDeps = {
  configPath?: string;
  env?: Record<string, string | undefined>;
  resolveApiPreset?(name: string): ImageRecognitionApiPreset | undefined;
  llmRequestSender?: LLMRequestSender;
  promptRenderer?: PromptContextRuntime | (() => PromptContextRuntime);
  createLlmClientFromPreset?(preset: ImageRecognitionApiPreset, env: Record<string, string | undefined>): LLMClient | undefined;
  appendLog?(level: "info" | "warn" | "error", message: string): void;
};

export const defaultImageRecognitionConfigPath = "config/plugin/image-recognition/config.json";

export function readImageRecognitionConfig(configPath = defaultImageRecognitionConfigPath): ImageRecognitionConfig {
  if (!fs.existsSync(configPath)) {
    return {
      enabled: false,
      prompt: defaultImageRecognitionPrompt,
      extraParams: defaultImageRecognitionExtraParams()
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    return {
      enabled: parsed.enabled === true,
      apiPresetName: stringValue(parsed.apiPresetName),
      prompt: stringValue(parsed.prompt) ?? defaultImageRecognitionPrompt,
      extraParams: recordValue(parsed.extraParams) ?? defaultImageRecognitionExtraParams(),
      testImagePath: stringValue(parsed.testImagePath)
    };
  } catch {
    return {
      enabled: false,
      prompt: defaultImageRecognitionPrompt,
      extraParams: defaultImageRecognitionExtraParams()
    };
  }
}

export async function recognizeImageWithPlugin(
  input: ImageRecognitionInput,
  config: ImageRecognitionConfig,
  deps: ImageRecognitionDeps = {}
): Promise<ImageRecognitionResult | ImageRecognitionError> {
  const startedAt = Date.now();
  if (!config.enabled) return { ok: false, error: "image_recognition_disabled" };
  try {
    const preset = config.apiPresetName ? deps.resolveApiPreset?.(config.apiPresetName) : undefined;
    const client = preset ? deps.createLlmClientFromPreset?.(preset, deps.env ?? process.env) : undefined;
    const prompt = renderPrompt(input.prompt ?? config.prompt ?? defaultImageRecognitionPrompt, deps);
    if (!config.apiPresetName || !preset || !client || !deps.llmRequestSender || !prompt) {
      return { ok: false, error: "missing_provider_config" };
    }

    const image = await readImageInput(input);
    const mimeType = input.mimeType || mimeTypeForFileName(input.filename || image.filename);
    if (!mimeType.startsWith("image/")) return { ok: false, error: "unsupported_image_format" };
    const result = await deps.llmRequestSender({
      agentId: "image_recognition",
      client,
      presetName: config.apiPresetName,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageDataUrl(image.bytes, mimeType) } },
          { type: "text", text: prompt }
        ]
      }],
      model: preset.model,
      temperature: preset.temperature,
      extraParams: config.extraParams ?? defaultImageRecognitionExtraParams(),
      toolNames: [],
      round: 0,
      stream: false,
      metadata: {
        pluginId: "image-recognition",
        filename: input.filename || image.filename,
        mimeType,
        ...(input.metadata ?? {})
      }
    });
    const text = typeof result.message.content === "string" ? result.message.content.trim() : "";
    if (!text) return { ok: false, error: "empty_description", requestId: result.id };
    return {
      text,
      provider: "multimodal_llm",
      model: result.model ?? preset.model,
      durationMs: Date.now() - startedAt,
      requestId: result.id,
      raw: result.raw
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.appendLog?.("warn", `image-recognition failed: ${message}`);
    return {
      ok: false,
      error: message === "missing_image_file" ? "missing_image_file" : "provider_request_failed",
      message
    };
  }
}

async function readImageInput(input: ImageRecognitionInput): Promise<{ bytes: Uint8Array; filename: string }> {
  const imageFile = input.imageFile;
  if (typeof imageFile === "string") {
    if (!fs.existsSync(imageFile)) throw new Error("missing_image_file");
    const stats = fs.statSync(imageFile);
    if (!stats.isFile() || stats.size <= 0) throw new Error("missing_image_file");
    return { bytes: fs.readFileSync(imageFile), filename: input.filename || path.basename(imageFile) };
  }
  if (imageFile instanceof Uint8Array) return { bytes: imageFile, filename: input.filename || "image" };
  if (imageFile instanceof Blob) {
    const bytes = (Buffer as any).from(await imageFile.arrayBuffer()) as Uint8Array;
    return { bytes, filename: input.filename || ("name" in imageFile && typeof imageFile.name === "string" ? imageFile.name : "image") };
  }
  throw new Error("unsupported_image_format");
}

function renderPrompt(prompt: string, deps: ImageRecognitionDeps): string {
  if (!deps.promptRenderer) throw new Error("prompt_context_runtime_required");
  const renderer = typeof deps.promptRenderer === "function" ? deps.promptRenderer() : deps.promptRenderer;
  return renderer.renderText(prompt);
}

function imageDataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function mimeTypeForFileName(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
