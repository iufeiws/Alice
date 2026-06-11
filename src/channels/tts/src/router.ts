const fs = await import("node:fs");
const path = await import("node:path");
import type {
  TtsPluginConfig,
  TtsPluginDeps,
  VoiceSynthesisInput,
  VoiceSynthesisResult,
  VoiceSynthesizer
} from "./types.js";

import { writePcmL16Wav } from "./audio-utils.js";
import { selectedTtsConversionProvider } from "./config.js";
import { createTtsConversionSynthesizer } from "./conversion.js";
import { resolveAssetOutputDir, uniqueVoiceBaseName, validateGeneratedVoice } from "./internal.js";

export const ttsSymbolSilenceMs = 200;
const silenceSampleRateHz = 32_000;
const silenceChannels = 1;

type TtsRouterCache = {
  key?: string;
  provider?: VoiceSynthesizer;
};

type TtsProviderRateLimitState = {
  starts: number[];
  tail: Promise<void>;
};

const routerCaches = new WeakMap<TtsPluginDeps, TtsRouterCache>();
const providerRateLimits = new Map<string, TtsProviderRateLimitState>();
const providerRateLimitMaxRequests = 3;
const providerRateLimitWindowMs = 1000;

export async function synthesizeTtsRouted(
  input: VoiceSynthesisInput,
  config: TtsPluginConfig,
  deps: TtsPluginDeps,
  options: { genie?: VoiceSynthesisInput["genie"] } = {}
): Promise<VoiceSynthesisResult> {
  const symbolOnly = ttsSymbolOnlyInput(input.text);
  if (symbolOnly) {
    deps.appendLog?.("info", `tts routed silence: chars=${Array.from(input.text).length} symbols=${symbolOnly.symbols} durationMs=${symbolOnly.durationMs}`);
    return silenceSynthesizer(input, symbolOnly);
  }

  const conversion = selectedTtsConversionProvider(config);
  const providerKey = ttsProviderCacheKey(conversion, config);
  const provider = resolveCachedTtsProvider(conversion, providerKey, config, deps);
  await waitForTtsProviderRateLimit(providerKey);
  return provider({
    ...input,
    ...(provider === deps.baseSynthesizer && options.genie !== undefined ? { genie: options.genie } : {})
  });
}

export function ttsSymbolOnlyInput(text: string): { symbols: number; durationMs: number } | undefined {
  const chars = Array.from(text).filter((char) => !/\s/u.test(char));
  if (chars.length === 0) return { symbols: 0, durationMs: ttsSymbolSilenceMs };
  for (const char of chars) {
    if (!/[\p{P}\p{S}]/u.test(char)) return undefined;
  }
  return { symbols: chars.length, durationMs: chars.length * ttsSymbolSilenceMs };
}

export function ttsSilentPcmL16(durationMs: number, format: { sampleRateHz?: number; channels?: number } = {}): Uint8Array {
  const bytesPerMs = ((format.sampleRateHz ?? silenceSampleRateHz) * (format.channels ?? silenceChannels) * 2) / 1000;
  return new Uint8Array(Math.max(2, Math.round(durationMs * bytesPerMs)));
}

function resolveCachedTtsProvider(
  conversion: "genie" | "openai-api" | "bailian",
  key: string,
  config: TtsPluginConfig,
  deps: TtsPluginDeps
): VoiceSynthesizer {
  if (conversion === "genie") return deps.baseSynthesizer;
  const cache = routerCaches.get(deps) ?? {};
  if (cache.key === key && cache.provider) return cache.provider;
  const provider = createTtsConversionSynthesizer(conversion, config, deps) ?? deps.baseSynthesizer;
  routerCaches.set(deps, { key, provider });
  return provider;
}

function ttsProviderCacheKey(conversion: "genie" | "openai-api" | "bailian", config: TtsPluginConfig): string {
  if (conversion === "openai-api") return JSON.stringify({ conversion, config: config.conversion?.openaiApi });
  if (conversion === "bailian") return JSON.stringify({ conversion, config: config.conversion?.bailian });
  return JSON.stringify({ conversion });
}

async function waitForTtsProviderRateLimit(key: string): Promise<void> {
  const state = providerRateLimits.get(key) ?? { starts: [], tail: Promise.resolve() };
  providerRateLimits.set(key, state);
  const run = state.tail.then(async () => {
    while (true) {
      const now = Date.now();
      state.starts = state.starts.filter((startedAt) => now - startedAt < providerRateLimitWindowMs);
      if (state.starts.length < providerRateLimitMaxRequests) {
        state.starts.push(now);
        return;
      }
      const waitMs = providerRateLimitWindowMs - (now - state.starts[0]!) + 1;
      await sleep(Math.max(1, waitMs));
    }
  });
  state.tail = run.catch(() => {});
  await run;
}

function silenceSynthesizer(input: VoiceSynthesisInput, symbolOnly: { durationMs: number }): VoiceSynthesisResult {
  const outputDir = resolveAssetOutputDir(path.join("assets", "generated", "tts"));
  fs.mkdirSync(outputDir.fullPath, { recursive: true });
  const baseName = uniqueSilenceBaseName(outputDir.fullPath, input.time.now().iso);
  const filePath = path.join(outputDir.fullPath, `${baseName}.wav`);
  const pcm = ttsSilentPcmL16(symbolOnly.durationMs, {
    sampleRateHz: silenceSampleRateHz,
    channels: silenceChannels
  });
  writePcmL16Wav(filePath, pcm, silenceSampleRateHz, silenceChannels);
  validateGeneratedVoice(filePath, outputDir.fullPath);
  return {
    assetId: path.join(outputDir.relativePath, `${baseName}.wav`),
    filePath
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueSilenceBaseName(outputDir: string, iso: string): string {
  let candidate = `${uniqueVoiceBaseName(outputDir, iso)}-silence`;
  let suffix = 2;
  while (fs.existsSync(path.join(outputDir, `${candidate}.wav`)) || fs.existsSync(path.join(outputDir, `${candidate}.opus`))) {
    candidate = `${uniqueVoiceBaseName(outputDir, iso)}-silence_${suffix}`;
    suffix += 1;
  }
  return candidate;
}
