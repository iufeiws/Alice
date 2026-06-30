import type { SelfieGenerationMode } from "./config.js";
import { runAliceSelfieFastSkill } from "./codex-selfie.js";
import { runOpenAIAPISelfie } from "./openai-api-selfie.js";
import type { SelfieExecutor, SelfieExecutorInput, SelfieExecutorResult } from "./selfie-tool.js";

const crypto = await import("node:crypto");
const path = await import("node:path");

const maxPhotoProviderConcurrency = 2;
const runningPhotoProviderRequests = new Set<string>();

export async function runPhotoProvider(input: SelfieExecutorInput, executor: SelfieExecutor): Promise<SelfieExecutorResult | void> {
  const requestKey = photoProviderRequestKey(input);
  if (runningPhotoProviderRequests.has(requestKey)) throw new Error("photo provider duplicate request is already running");
  if (runningPhotoProviderRequests.size >= maxPhotoProviderConcurrency) throw new Error("photo provider concurrency limit reached");
  runningPhotoProviderRequests.add(requestKey);
  try {
    return await executor(input);
  } finally {
    runningPhotoProviderRequests.delete(requestKey);
  }
}

export function photoProviderExecutorForMode(mode: SelfieGenerationMode): SelfieExecutor {
  return mode === "codex" ? runAliceSelfieFastSkill : runOpenAIAPISelfie;
}

function photoProviderRequestKey(input: SelfieExecutorInput): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    prompt: input.prompt,
    referenceImages: input.referenceImages.map((image) => path.resolve(image))
  })).digest("hex");
}
