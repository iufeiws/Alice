import { extensionForOutputFormat, selectedImageApiSettings, type PhotoPluginConfig, type SelfieGenerationMode } from "./config.js";
import { runAliceSelfieFastSkill } from "./codex-provider.js";
import { runOpenAIAPISelfie } from "./openai-api-provider.js";
import { runXaiAPISelfie } from "./xai-api-provider.js";

const crypto = await import("node:crypto");
const path = await import("node:path");

const maxPhotoProviderConcurrency = 2;
const runningPhotoProviderRequests = new Set<string>();

export type ImageGenerationProviderInput = {
  command: string;
  workDir: string;
  codexWorkDir?: string;
  fileName: string;
  prompt: string;
  codexExtraPrompt: string;
  referenceImages: string[];
  referenceImagePrompt: string;
  timeoutMs: number;
  apiKey?: string;
  credentialId?: string;
  apiBaseURL: string;
  apiEndpoint: "edits" | "relayEdits" | "xaiEdits";
  apiModel: string;
  apiSize: string;
  apiQuality: string;
  apiModeration: string;
  apiOutputFormat: string;
  apiOutputCompression: number;
  apiTimeoutMs: number;
  xaiAspectRatio?: string;
  xaiResolution?: string;
  proxyUrl?: string;
};

export type ImageGenerationProviderResult = {
  stdout?: string;
  stderr?: string;
  lastMessage?: string;
  events?: string;
};

export type ImageGenerationProvider = (input: ImageGenerationProviderInput) => Promise<ImageGenerationProviderResult | void>;

export type PhotoGatewayInput = {
  config: PhotoPluginConfig;
  provider?: SelfieGenerationMode;
  workDir: string;
  codexWorkDir?: string;
  fileBaseName: string;
  prompt: string;
  referenceImages: string[];
  referenceImagePrompt?: string;
  proxyUrl?: string;
  executor?: ImageGenerationProvider;
};

export type PhotoGatewayResult = ImageGenerationProviderResult & {
  fileName: string;
  timeoutMs: number;
};

export async function runImageGenerationProvider(input: ImageGenerationProviderInput, executor: ImageGenerationProvider): Promise<ImageGenerationProviderResult | void> {
  const requestKey = imageGenerationRequestKey(input);
  if (runningPhotoProviderRequests.has(requestKey)) throw new Error("image generation duplicate request is already running");
  if (runningPhotoProviderRequests.size >= maxPhotoProviderConcurrency) throw new Error("image generation concurrency limit reached");
  runningPhotoProviderRequests.add(requestKey);
  try {
    return await executor(input);
  } finally {
    runningPhotoProviderRequests.delete(requestKey);
  }
}

export function imageGenerationProviderForMode(mode: SelfieGenerationMode): ImageGenerationProvider {
  if (mode === "codex") return runAliceSelfieFastSkill;
  return mode === "xai" ? runXaiAPISelfie : runOpenAIAPISelfie;
}

export async function runPhotoGateway(input: PhotoGatewayInput): Promise<PhotoGatewayResult> {
  const provider = input.provider ?? input.config.selfieMode;
  const imageApiSettings = selectedImageApiSettings({ ...input.config, selfieMode: provider });
  if (!input.executor && provider !== "codex" && !imageApiSettings.key && !imageApiSettings.credentialId) throw new Error("missing_photo_image_api_credential");
  const fileName = `${input.fileBaseName}.${extensionForOutputFormat(imageApiSettings.outputFormat)}`;
  const timeoutMs = provider === "codex" ? input.config.selfieCodexTimeoutMs : imageApiSettings.timeoutMs;
  const result = await runImageGenerationProvider({
    command: input.config.selfieCodexCommand,
    workDir: input.workDir,
    codexWorkDir: input.codexWorkDir,
    fileName,
    prompt: input.prompt,
    codexExtraPrompt: input.config.selfieCodexExtraPrompt,
    referenceImages: input.referenceImages,
    referenceImagePrompt: input.referenceImagePrompt ?? "",
    timeoutMs,
    apiKey: imageApiSettings.key,
    credentialId: imageApiSettings.credentialId,
    apiBaseURL: imageApiSettings.baseURL,
    apiEndpoint: imageApiSettings.endpoint,
    apiModel: imageApiSettings.model,
    apiSize: imageApiSettings.size,
    apiQuality: imageApiSettings.quality,
    apiModeration: imageApiSettings.moderation,
    apiOutputFormat: imageApiSettings.outputFormat,
    apiOutputCompression: imageApiSettings.outputCompression,
    apiTimeoutMs: imageApiSettings.timeoutMs,
    xaiAspectRatio: imageApiSettings.xaiAspectRatio,
    xaiResolution: imageApiSettings.xaiResolution,
    proxyUrl: input.proxyUrl
  }, input.executor ?? imageGenerationProviderForMode(provider));
  return { ...(result ?? {}), fileName, timeoutMs };
}

function imageGenerationRequestKey(input: ImageGenerationProviderInput): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    prompt: input.prompt,
    referenceImages: input.referenceImages.map((image) => path.resolve(image))
  })).digest("hex");
}
