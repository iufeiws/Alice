import type { ModelCatalog, ModelPrice, TokenUsageStore } from "../../../platform/storage/src/token-usage-store.js";

const MODELS_DEV_URL = "https://models.dev/api.json";
const HOUR_MS = 60 * 60 * 1000;

export type LLMPriceTarget = { baseURL: string; model: string };

export function createModelPriceSync(input: {
  store: TokenUsageStore;
  now(): Date;
  fetch?: typeof fetch;
  appendLog?(level: "warn", message: string): void;
}) {
  let refreshInFlight: Promise<void> | undefined;

  return { refreshCatalogIfExpired, recordModelPrice };

  async function refreshCatalogIfExpired(): Promise<void> {
    const now = input.now();
    const nowUtc = now.toISOString();
    if (input.store.catalogNeedsRefresh(nowUtc, HOUR_MS)) {
      refreshInFlight ??= refreshCatalog(now).finally(() => { refreshInFlight = undefined; });
      await refreshInFlight;
    }
  }

  async function recordModelPrice(target: LLMPriceTarget, observedAtUtc?: string) {
    await refreshCatalogIfExpired();
    const baseURL = normalizeHttpURL(target.baseURL);
    if (!baseURL) return undefined;
    const price = input.store.recordModelPrice({ baseURL, model: target.model, observedAtUtc: observedAtUtc ?? input.now().toISOString() });
    if (price?.ambiguousProviderIds) {
      input.appendLog?.("warn", `model price provider match is ambiguous: base_url=${baseURL} model=${target.model} providers=${price.ambiguousProviderIds.join(",")} selected=${price.providerId}`);
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
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) throw new Error("models_dev_catalog_invalid");
    const apiURL = (provider as { api?: unknown }).api;
    if (apiURL !== undefined && typeof apiURL !== "string") throw new Error("models_dev_catalog_invalid");
    const models = (provider as { models?: unknown }).models;
    catalog.providers.push({ providerId, apiURL: typeof apiURL === "string" ? apiURL : undefined });
    if (!models || typeof models !== "object" || Array.isArray(models)) throw new Error("models_dev_catalog_invalid");
    for (const [modelId, model] of Object.entries(models as Record<string, unknown>)) {
      if (!model || typeof model !== "object" || Array.isArray(model)) throw new Error("models_dev_catalog_invalid");
      const cost = (model as { cost?: unknown }).cost;
      const price = normalizePrice(cost);
      catalog.models.push({ providerId, modelId, price });
    }
  }
  if (catalog.providers.length === 0 || catalog.models.length === 0) throw new Error("models_dev_catalog_invalid");
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

function normalizePrice(value: unknown): ModelPrice | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("models_dev_catalog_invalid");
  const raw = value as Record<string, unknown>;
  if (typeof raw.input !== "number" || !Number.isFinite(raw.input)
    || typeof raw.output !== "number" || !Number.isFinite(raw.output)) {
    throw new Error("models_dev_catalog_invalid");
  }
  for (const key of ["cache_read", "cache_write"]) {
    if (raw[key] !== undefined && (typeof raw[key] !== "number" || !Number.isFinite(raw[key]))) {
      throw new Error("models_dev_catalog_invalid");
    }
  }
  return { ...raw, input: raw.input, output: raw.output };
}
