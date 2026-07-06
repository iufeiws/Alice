import type { AsrPluginConfig, AsrPluginDeps, AsrTranscribeError, AsrTranscribeInput, AsrTranscribeResult } from "./types.js";
import { AsrConfigError } from "./errors.js";
import { transcribeMultimodalLlm } from "./multimodal-llm.js";
import { transcribeOpenAiCompatible } from "./openai-compatible.js";
import { transcribeTencent } from "./tencent.js";

export async function transcribeWithAsrPlugin(
  input: AsrTranscribeInput,
  config: AsrPluginConfig,
  deps: AsrPluginDeps = {}
): Promise<AsrTranscribeResult | AsrTranscribeError> {
  const provider = input.provider ?? config.defaultProvider;
  const startedAt = Date.now();
  if (!config.enabled) return { ok: false, error: "asr_disabled", provider };
  if (!input.audioFile) return { ok: false, error: "missing_audio_file", provider };

  try {
    const result = provider === "tencent"
      ? await transcribeTencent(input, config, deps)
      : provider === "multimodal_llm"
        ? await transcribeMultimodalLlm(input, config, deps)
        : await transcribeOpenAiCompatible(input, config, deps);
    const text = result.text.trim();
    if (!text) return { ok: false, error: "empty_transcription", provider, requestId: result.requestId };
    return {
      ...result,
      text,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    if (error instanceof AsrConfigError) return { ok: false, error: error.code, provider };
    const message = error instanceof Error ? error.message : String(error);
    deps.appendLog?.("warn", `asr ${provider} failed: ${message}`);
    return {
      ok: false,
      error: message === "timeout" ? "timeout" : "provider_request_failed",
      provider,
      message
    };
  }
}
