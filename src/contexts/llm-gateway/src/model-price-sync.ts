import type { TokenUsageStore } from "../../../platform/storage/src/token-usage-store.js";

const MODELS_DEV_URL = "https://models.dev/api.json";
const HOUR_MS = 60 * 60 * 1000;

export type LLMPricePreset = { baseURL: string; model: string; name?: string };

export function createModelPriceSync(input: {
  store: TokenUsageStore;
  now(): Date;
  fetch?: typeof fetch;
}) {
  let refreshInFlight: Promise<void> | undefined;

  return { resolvePrice };

  async function resolvePrice(preset: LLMPricePreset | undefined) {
    if (!preset?.baseURL || !preset.model) return undefined;
    const now = input.now();
    const baseURL = normalizeHttpURL(preset.baseURL);
    if (!baseURL) return undefined;
    const nowUtc = now.toISOString();
    const catalogExpired = input.store.providerNeedsRefresh({ baseURL, nowUtc, maxAgeMs: HOUR_MS });
    let priceExpired = input.store.modelPriceNeedsRefresh({ baseURL, model: preset.model, nowUtc, maxAgeMs: HOUR_MS });
    if (catalogExpired) {
      refreshInFlight ??= refreshCatalog(now, baseURL, preset.model).finally(() => { refreshInFlight = undefined; });
      await refreshInFlight;
      priceExpired = true;
    }
    if (!priceExpired) return undefined;
    return input.store.refreshModelPrice({ baseURL, model: preset.model, updatedAtUtc: nowUtc });
  }

  async function refreshCatalog(now: Date, baseURL: string, modelId: string): Promise<void> {
    const response = await (input.fetch ?? fetch)(MODELS_DEV_URL);
    if (!response.ok) throw new Error(`models_dev_catalog_failed:${response.status}`);
    const body: unknown = await response.json();
    const row = findCurrentPresetPrice(body, baseURL, modelId);
    if (row) input.store.replaceModelCatalog([row], now.toISOString());
  }
}

function findCurrentPresetPrice(value: unknown, baseURL: string, modelId: string): { providerId: string; apiURL: string; modelId: string; price: Record<string, number> } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("models_dev_catalog_invalid");
  for (const [providerId, provider] of Object.entries(value as Record<string, unknown>)) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) continue;
    const apiURL = (provider as { api?: unknown }).api;
    const models = (provider as { models?: unknown }).models;
    if (typeof apiURL !== "string" || normalizeHttpURL(apiURL) !== baseURL || !models || typeof models !== "object" || Array.isArray(models)) continue;
    const model = (models as Record<string, unknown>)[modelId];
    const cost = model && typeof model === "object" && !Array.isArray(model) ? (model as { cost?: unknown }).cost : undefined;
    const price = normalizePrice(cost);
    if (price) return { providerId, apiURL, modelId, price };
  }
  return undefined;
}

function normalizeHttpURL(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
    return `${url.origin}${path}`;
  } catch {
    return undefined;
  }
}

function normalizePrice(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const price: Record<string, number> = {};
  for (const key of ["input", "output", "cache_read", "cache_write"]) {
    if (typeof raw[key] === "number" && Number.isFinite(raw[key])) price[key] = raw[key];
  }
  return typeof price.input === "number" && typeof price.output === "number" ? price : undefined;
}
