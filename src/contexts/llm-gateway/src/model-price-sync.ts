import type { ModelCatalog, TokenUsageStore } from "../../../platform/storage/src/token-usage-store.js";

const MODELS_DEV_URL = "https://models.dev/api.json";
const HOUR_MS = 60 * 60 * 1000;

export type LLMPricePreset = { baseURL: string; model: string; name?: string };

export function createModelPriceSync(input: {
  store: TokenUsageStore;
  now(): Date;
  fetch?: typeof fetch;
  appendLog?(level: "warn", message: string): void;
}) {
  let refreshInFlight: Promise<void> | undefined;

  return { resolvePrice };

  async function resolvePrice(preset: LLMPricePreset | undefined, observedAtUtc?: string) {
    const now = input.now();
    const nowUtc = now.toISOString();
    if (input.store.catalogNeedsRefresh(nowUtc, HOUR_MS)) {
      refreshInFlight ??= refreshCatalog(now).finally(() => { refreshInFlight = undefined; });
      await refreshInFlight;
    }
    if (!preset?.baseURL || !preset.model) return undefined;
    const baseURL = normalizeHttpURL(preset.baseURL);
    if (!baseURL) return undefined;
    const price = input.store.recordModelPrice({ baseURL, model: preset.model, observedAtUtc: observedAtUtc ?? nowUtc });
    if (price?.ambiguousProviderIds) {
      input.appendLog?.("warn", `model price provider match is ambiguous: base_url=${baseURL} model=${preset.model} providers=${price.ambiguousProviderIds.join(",")} selected=${price.providerId}`);
    }
    return price;
  }

  async function refreshCatalog(now: Date): Promise<void> {
    const response = await (input.fetch ?? fetch)(MODELS_DEV_URL);
    if (!response.ok) throw new Error(`models_dev_catalog_failed:${response.status}`);
    const body: unknown = await response.json();
    input.store.replaceModelCatalog(readModelCatalog(body), now.toISOString());
  }
}

function readModelCatalog(value: unknown): ModelCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("models_dev_catalog_invalid");
  const catalog: ModelCatalog = { providers: [], models: [] };
  for (const [providerId, provider] of Object.entries(value as Record<string, unknown>)) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) continue;
    const apiURL = (provider as { api?: unknown }).api;
    const models = (provider as { models?: unknown }).models;
    catalog.providers.push({ providerId, apiURL: typeof apiURL === "string" ? apiURL : undefined });
    if (!models || typeof models !== "object" || Array.isArray(models)) continue;
    for (const [modelId, model] of Object.entries(models as Record<string, unknown>)) {
      const cost = model && typeof model === "object" && !Array.isArray(model) ? (model as { cost?: unknown }).cost : undefined;
      const price = normalizePrice(cost);
      catalog.models.push({ providerId, modelId, price });
    }
  }
  return catalog;
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
