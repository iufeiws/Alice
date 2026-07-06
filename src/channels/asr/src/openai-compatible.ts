import type { AsrPluginConfig, AsrPluginDeps, AsrTranscribeInput, AsrTranscribeResult } from "./types.js";
import { bufferToArrayBuffer, fetchWithTimeout, retryAsync, retryOptions, stringValue } from "./utils.js";
import { mimeTypeForFileName, readAudioInput } from "./audio.js";
import { AsrConfigError } from "./errors.js";

export async function transcribeOpenAiCompatible(input: AsrTranscribeInput, config: AsrPluginConfig, deps: AsrPluginDeps): Promise<AsrTranscribeResult> {
  const providerConfig = config.providers.openaiCompatible;
  const preset = providerConfig?.apiPresetName ? deps.resolveApiPreset?.(providerConfig.apiPresetName) : undefined;
  const apiKey = preset?.apiKey;
  const model = preset?.model;
  if (!providerConfig?.apiPresetName || !preset?.baseURL || !apiKey || !model) {
    throw new AsrConfigError("missing_provider_config");
  }

  const audio = await readAudioInput(input);
  const form = new FormData();
  form.append("file", new Blob([bufferToArrayBuffer(audio.bytes)], { type: input.mimeType || mimeTypeForFileName(audio.filename) }), input.filename || audio.filename);
  form.append("model", model);
  if (input.language) form.append("language", input.language);
  if (input.prompt) form.append("prompt", input.prompt);
  if (providerConfig.responseFormat) form.append("response_format", providerConfig.responseFormat);

  const response = await retryAsync(() => fetchWithTimeout(deps.fetch ?? fetch, `${preset.baseURL.replace(/\/+$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`
    },
    body: form
  }, preset.timeoutMs), retryOptions(providerConfig, deps));
  if (!response.ok) throw new Error(`openai_compatible_asr_failed:${response.status}:${await response.text()}`);

  const responseFormat = providerConfig.responseFormat ?? "json";
  const raw = responseFormat === "text" ? await response.text() : await response.json();
  const text = typeof raw === "string" ? raw : stringValue((raw as { text?: unknown }).text) ?? "";
  return {
    text,
    provider: "openai_compatible",
    model,
    language: input.language,
    raw
  };
}
