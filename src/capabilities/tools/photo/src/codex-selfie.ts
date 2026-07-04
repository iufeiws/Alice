import type { SelfieExecutorInput, SelfieExecutorResult } from "./selfie-tool.js";
import { execFile } from "./process-exec.js";

const fs = await import("node:fs");
const path = await import("node:path");

const defaultFastSelfieRunner = path.resolve("src/capabilities/skills/external/alice-selfie-fast/scripts/run-alice-selfie-fast.mjs");

export async function runAliceSelfieFastSkill(input: SelfieExecutorInput): Promise<SelfieExecutorResult> {
  const runnerPath = process.env.ALICE_SELFIE_FAST_RUNNER ?? defaultFastSelfieRunner;
  const configPath = path.join(input.workDir, "alice-selfie-fast-input.json");
  const runnerTimeoutMs = Math.max(1_000, input.timeoutMs - 2_000);
  fs.writeFileSync(configPath, JSON.stringify({
    workDir: input.workDir,
    codexWorkDir: input.codexWorkDir,
    fileName: input.fileName,
    prompt: input.prompt,
    extraPrompt: input.codexExtraPrompt,
    referenceImages: input.referenceImages,
    referenceImagePrompt: input.referenceImagePrompt,
    codexCommand: input.command,
    timeoutMs: runnerTimeoutMs
  }));
  const result = await execFile("node", [runnerPath, "--tool-input", configPath], input.timeoutMs, {
    OPENAI_API_KEY: "",
    OPENAI_BASE_URL: "",
    SELFIE_IMAGE_API_KEY: "",
    SELFIE_IMAGE_API_BASE_URL: "",
    SELFIE_IMAGE_API_MODEL: "",
    SELFIE_IMAGE_API_SIZE: "",
    SELFIE_IMAGE_API_QUALITY: "",
    SELFIE_IMAGE_API_OUTPUT_FORMAT: "",
    SELFIE_IMAGE_API_OUTPUT_COMPRESSION: "",
    SELFIE_IMAGE_API_TIMEOUT_MS: ""
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    lastMessage: excerpt(result.stderr || result.stdout, 1000),
    events: result.stdout
  };
}

function excerpt(value: string | undefined, maxLength = 500): string {
  const compact = value?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}
