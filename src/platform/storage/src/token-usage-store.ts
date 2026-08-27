import * as sqlite from "./sqlite-compat.js";
import { createCurrentTimeProvider, formatZonedIso, parseZonedIso } from "../../../platform/time/src/index.js";
import type { CurrentTimeProvider } from "../../../shared/clock/src/index.js";

const fs = await import("node:fs");
const path = await import("node:path");

type DatabaseSync = any;

export type TokenUsageEventInput = {
  createdAt: string;
  createdAtUtc?: string;
  agentId: string;
  model?: string;
  sessionId?: number | string;
  requestId?: number;
  responseId?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  finishReason?: string;
  rawUsageJson?: string;
  providerId?: string;
};

export type StoredTokenUsageEvent = Required<Pick<TokenUsageEventInput, "createdAt" | "agentId">> & {
  id: number;
  createdAtUtc?: string;
  model?: string;
  sessionId?: number | string;
  requestId?: number;
  responseId?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  cacheHitRate?: number;
  finishReason?: string;
  rawUsageJson?: string;
  providerId?: string;
  costUsd?: number;
};

export type TokenUsageQuery = {
  since?: string;
  bucket?: "hour" | "day";
  agentId?: string;
  model?: string;
  latestLimit?: number;
};

export type TokenUsageAggregate = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  costUsd: number;
  cacheHitRate?: number;
};

export type TokenUsageBucket = TokenUsageAggregate & {
  bucket: string;
};

export type TokenUsageModelBucket = TokenUsageBucket & {
  model: string;
};

export type TokenUsageModelAggregate = TokenUsageAggregate & {
  model: string;
};

export type TokenUsageReport = {
  summary: TokenUsageAggregate;
  buckets: TokenUsageBucket[];
  byModel: TokenUsageModelAggregate[];
  byModelBucket: TokenUsageModelBucket[];
  latest: StoredTokenUsageEvent[];
};

export type ModelPrice = Record<string, unknown> & {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
};

export type ModelCatalog = {
  providers: Array<{ providerId: string; apiURL?: string }>;
  models: Array<{ providerId: string; modelId: string; price?: ModelPrice }>;
};

export type ModelCatalogStats = { providers: number; models: number; pricedModels: number };

export type TokenUsageStore = {
  insert(input: TokenUsageEventInput): StoredTokenUsageEvent;
  assignProviderId(eventId: number, providerId?: string): void;
  report(query?: TokenUsageQuery): TokenUsageReport;
  catalogNeedsRefresh(nowUtc: string, maxAgeMs: number): boolean;
  replaceModelCatalog(catalog: ModelCatalog, updatedAtUtc: string): ModelCatalogStats;
  getModelCatalogStats(): ModelCatalogStats;
  recordModelPrice(input: { baseURL: string; model: string; observedAtUtc: string }): StoredModelPrice | undefined;
};

export type StoredModelPrice = {
  id?: number;
  providerId: string;
  modelId: string;
  price?: ModelPrice;
  ambiguousProviderIds?: string[];
};

export function createTokenUsageStore(dbPath: string, options: { time?: CurrentTimeProvider } = {}): TokenUsageStore {
  const time = options.time ?? createCurrentTimeProvider("UTC");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db: DatabaseSync = new sqlite.DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      created_at_utc TEXT,
      agent_id TEXT NOT NULL,
      model TEXT,
      session_id INTEGER,
      request_id INTEGER,
      response_id INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      cache_hit_tokens INTEGER,
      cache_miss_tokens INTEGER,
      cache_hit_rate REAL,
      finish_reason TEXT,
      raw_usage_json TEXT,
      provider_id TEXT
    );

    CREATE INDEX IF NOT EXISTS token_usage_created_at_idx ON token_usage_events(created_at);
    CREATE INDEX IF NOT EXISTS token_usage_agent_model_idx ON token_usage_events(agent_id, model, created_at);
    CREATE INDEX IF NOT EXISTS token_usage_created_at_utc_idx ON token_usage_events(created_at_utc);
    CREATE TABLE IF NOT EXISTS llm_model_catalog_sync (
      source TEXT PRIMARY KEY,
      updated_at_utc TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_latest_model_providers (
      provider_id TEXT PRIMARY KEY,
      api_url TEXT,
      normalized_api_url TEXT,
      catalog_order INTEGER NOT NULL,
      updated_at_utc TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS llm_latest_model_providers_api_idx ON llm_latest_model_providers(normalized_api_url);
    CREATE TABLE IF NOT EXISTS llm_latest_model_prices (
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      price_json TEXT,
      input_per_mtok REAL,
      output_per_mtok REAL,
      cache_read_per_mtok REAL,
      cache_write_per_mtok REAL,
      updated_at_utc TEXT NOT NULL,
      PRIMARY KEY(provider_id, model_id)
    );
    CREATE TABLE IF NOT EXISTS llm_model_price_timeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      price_json TEXT NOT NULL,
      input_per_mtok REAL NOT NULL,
      output_per_mtok REAL NOT NULL,
      cache_read_per_mtok REAL,
      cache_write_per_mtok REAL,
      first_seen_at_utc TEXT NOT NULL,
      last_seen_at_utc TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS llm_model_price_timeline_lookup_idx ON llm_model_price_timeline(provider_id, model_id, last_seen_at_utc);
  `);
  ensureColumn(db, "token_usage_events", "provider_id", "TEXT");
  const latestCatalogCount = Number(db.prepare("SELECT COUNT(*) AS count FROM llm_latest_model_prices").get()?.count ?? 0);
  if (latestCatalogCount === 0) db.prepare("DELETE FROM llm_model_catalog_sync WHERE source = 'models.dev'").run();

  return {
    insert(input) {
      const cacheHitRate = calculateCacheHitRate(input);
      const createdAtUtc = input.createdAtUtc ?? parseZonedIso(input.createdAt, time.timeZone).toISOString();
      const createdAt = formatZonedIso(new Date(createdAtUtc), time.timeZone);
      const result = db.prepare(`
        INSERT INTO token_usage_events(
          created_at, created_at_utc, agent_id, model, session_id, request_id, response_id,
          input_tokens, output_tokens, total_tokens, cache_hit_tokens,
          cache_miss_tokens, cache_hit_rate, finish_reason, raw_usage_json, provider_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        createdAt,
        createdAtUtc,
        input.agentId,
        input.model ?? null,
        input.sessionId ?? null,
        input.requestId ?? null,
        input.responseId ?? null,
        finiteNumberOrNull(input.inputTokens),
        finiteNumberOrNull(input.outputTokens),
        finiteNumberOrNull(input.totalTokens),
        finiteNumberOrNull(input.cacheHitTokens),
        finiteNumberOrNull(input.cacheMissTokens),
        cacheHitRate ?? null,
        input.finishReason ?? null,
        input.rawUsageJson ?? null,
        input.providerId ?? null
      );
      return rowToEvent(db.prepare(tokenUsageSelect("WHERE event.id = ?")).get(Number(result.lastInsertRowid)));
    },
    assignProviderId(eventId, providerId) {
      db.prepare("UPDATE token_usage_events SET provider_id = ? WHERE id = ?").run(providerId ?? null, eventId);
    },
    report(query = {}) {
      const filter = buildFilter(query);
      const bucketExpr = query.bucket === "day"
        ? "substr(event.created_at, 1, 10)"
        : "substr(event.created_at, 1, 13) || ':00'";
      const summary = aggregateRows(db.prepare(`
        SELECT ${aggregateSelect()}
        FROM ${tokenUsageFrom()}
        ${filter.where}
      `).get(...filter.values));
      const buckets = db.prepare(`
        SELECT ${bucketExpr} AS bucket, ${aggregateSelect()}
        FROM ${tokenUsageFrom()}
        ${filter.where}
        GROUP BY bucket
        ORDER BY bucket ASC
      `).all(...filter.values).map((row: any) => ({ bucket: row.bucket, ...aggregateRows(row) }));
      const byModel = db.prepare(`
        SELECT COALESCE(event.model, 'unknown') AS model, ${aggregateSelect()}
        FROM ${tokenUsageFrom()}
        ${filter.where}
        GROUP BY COALESCE(event.model, 'unknown')
        ORDER BY totalTokens DESC, requests DESC, model ASC
      `).all(...filter.values).map((row: any) => ({ model: row.model, ...aggregateRows(row) }));
      const byModelBucket = db.prepare(`
        SELECT COALESCE(event.model, 'unknown') AS model, ${bucketExpr} AS bucket, ${aggregateSelect()}
        FROM ${tokenUsageFrom()}
        ${filter.where}
        GROUP BY COALESCE(event.model, 'unknown'), bucket
        ORDER BY model ASC, bucket ASC
      `).all(...filter.values).map((row: any) => ({ model: row.model, bucket: row.bucket, ...aggregateRows(row) }));
      const latestLimit = Math.max(1, Math.min(200, Math.trunc(query.latestLimit ?? 50)));
      const latest = db.prepare(tokenUsageSelect(`${filter.where} ORDER BY event.id DESC LIMIT ?`))
        .all(...filter.values, latestLimit)
        .map(rowToEvent);
      return { summary, buckets, byModel, byModelBucket, latest };
    },
    catalogNeedsRefresh(nowUtc, maxAgeMs) {
      const row = db.prepare("SELECT updated_at_utc AS updatedAtUtc FROM llm_model_catalog_sync WHERE source = 'models.dev'").get();
      const updatedAt = typeof row?.updatedAtUtc === "string" ? Date.parse(row.updatedAtUtc) : Number.NaN;
      return !Number.isFinite(updatedAt) || Date.parse(nowUtc) - updatedAt >= maxAgeMs;
    },
    replaceModelCatalog(catalog, updatedAtUtc) {
      transaction(db, () => {
        db.prepare("DELETE FROM llm_latest_model_prices").run();
        db.prepare("DELETE FROM llm_latest_model_providers").run();
        const insertProvider = db.prepare(`INSERT INTO llm_latest_model_providers(
          provider_id, api_url, normalized_api_url, catalog_order, updated_at_utc
        ) VALUES (?, ?, ?, ?, ?)`);
        for (const [index, provider] of catalog.providers.entries()) {
          insertProvider.run(provider.providerId, provider.apiURL ?? null, normalizeProviderURL(provider.apiURL), index, updatedAtUtc);
        }
        const insertModel = db.prepare(`INSERT INTO llm_latest_model_prices(
          provider_id, model_id, price_json, input_per_mtok, output_per_mtok,
          cache_read_per_mtok, cache_write_per_mtok, updated_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const model of catalog.models) {
          insertModel.run(
            model.providerId,
            model.modelId,
            model.price ? canonicalPriceJson(model.price) : null,
            model.price?.input ?? null,
            model.price?.output ?? null,
            model.price?.cache_read ?? null,
            model.price?.cache_write ?? null,
            updatedAtUtc
          );
        }
        db.prepare(`INSERT INTO llm_model_catalog_sync(source, updated_at_utc) VALUES ('models.dev', ?)
          ON CONFLICT(source) DO UPDATE SET updated_at_utc = excluded.updated_at_utc`).run(updatedAtUtc);
      });
      return this.getModelCatalogStats();
    },
    getModelCatalogStats() {
      const row = db.prepare(`SELECT
        (SELECT COUNT(*) FROM llm_latest_model_providers) AS providers,
        COUNT(*) AS models,
        COUNT(price_json) AS pricedModels
        FROM llm_latest_model_prices`).get();
      return { providers: Number(row.providers), models: Number(row.models), pricedModels: Number(row.pricedModels) };
    },
    recordModelPrice(input) {
      const providerURL = normalizeProviderURL(input.baseURL);
      if (!providerURL) return undefined;
      const rows = db.prepare(`SELECT catalog.provider_id AS providerId, catalog.model_id AS modelId, catalog.price_json AS priceJson,
        catalog.input_per_mtok AS input, catalog.output_per_mtok AS output,
        catalog.cache_read_per_mtok AS cacheRead, catalog.cache_write_per_mtok AS cacheWrite
        FROM llm_latest_model_providers provider
        JOIN llm_latest_model_prices catalog ON catalog.provider_id = provider.provider_id
        WHERE provider.normalized_api_url = ? AND catalog.model_id = ?
        ORDER BY provider.catalog_order ASC LIMIT 2`).all(providerURL, input.model);
      if (rows.length === 0) return undefined;
      const row = rows[0];
      const ambiguousProviderIds = rows.length > 1 ? rows.map((candidate: any) => String(candidate.providerId)) : undefined;
      if (!row.priceJson) return { providerId: row.providerId, modelId: row.modelId, ambiguousProviderIds };
      const latest = db.prepare(`SELECT id, price_json AS priceJson FROM llm_model_price_timeline WHERE provider_id = ? AND model_id = ? ORDER BY id DESC LIMIT 1`).get(row.providerId, row.modelId);
      if (latest?.priceJson === row.priceJson) db.prepare("UPDATE llm_model_price_timeline SET last_seen_at_utc = ? WHERE id = ?").run(input.observedAtUtc, latest.id);
      else db.prepare(`INSERT INTO llm_model_price_timeline(provider_id, model_id, price_json, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, first_seen_at_utc, last_seen_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.providerId, row.modelId, row.priceJson, row.input, row.output, row.cacheRead, row.cacheWrite, input.observedAtUtc, input.observedAtUtc);
      const stored = db.prepare("SELECT id FROM llm_model_price_timeline WHERE provider_id = ? AND model_id = ? ORDER BY id DESC LIMIT 1").get(row.providerId, row.modelId);
      return {
        id: Number(stored.id),
        providerId: row.providerId,
        modelId: row.modelId,
        price: JSON.parse(row.priceJson) as ModelPrice,
        ambiguousProviderIds
      };
    }
  };
}

function buildFilter(query: TokenUsageQuery): { where: string; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (query.since) {
      clauses.push("event.created_at >= ?");
    values.push(query.since);
  }
  if (query.agentId && query.agentId !== "all") {
      clauses.push("event.agent_id = ?");
    values.push(query.agentId);
  }
  if (query.model && query.model !== "all") {
      clauses.push("COALESCE(event.model, 'unknown') = ?");
    values.push(query.model);
  }
  return {
    where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    values
  };
}

function aggregateSelect(): string {
  return `
    COUNT(*) AS requests,
    COALESCE(SUM(input_tokens), 0) AS inputTokens,
    COALESCE(SUM(output_tokens), 0) AS outputTokens,
    COALESCE(SUM(total_tokens), 0) AS totalTokens,
    COALESCE(SUM(cache_hit_tokens), 0) AS cacheHitTokens,
    COALESCE(SUM(cache_miss_tokens), 0) AS cacheMissTokens,
    COALESCE(SUM((COALESCE(cache_hit_tokens, 0) * COALESCE(price.cache_read_per_mtok, price.input_per_mtok)
      + COALESCE(cache_miss_tokens, MAX(0, COALESCE(input_tokens, 0) - COALESCE(cache_hit_tokens, 0))) * price.input_per_mtok
      + COALESCE(output_tokens, 0) * price.output_per_mtok) / 1000000.0), 0) AS costUsd
  `;
}

function aggregateRows(row: any): TokenUsageAggregate {
  const cacheHitTokens = Number(row?.cacheHitTokens ?? 0);
  const cacheMissTokens = Number(row?.cacheMissTokens ?? 0);
  return {
    requests: Number(row?.requests ?? 0),
    inputTokens: Number(row?.inputTokens ?? 0),
    outputTokens: Number(row?.outputTokens ?? 0),
    totalTokens: Number(row?.totalTokens ?? 0),
    cacheHitTokens,
    cacheMissTokens,
    costUsd: Number(row?.costUsd ?? 0),
    cacheHitRate: calculateCacheHitRate({ cacheHitTokens, cacheMissTokens })
  };
}

function calculateCacheHitRate(input: Pick<TokenUsageEventInput, "cacheHitTokens" | "cacheMissTokens" | "inputTokens">): number | undefined {
  if (typeof input.cacheHitTokens !== "number" || !Number.isFinite(input.cacheHitTokens)) return undefined;
  if (typeof input.cacheMissTokens === "number" && Number.isFinite(input.cacheMissTokens)) {
    const denominator = input.cacheHitTokens + input.cacheMissTokens;
    return denominator > 0 ? input.cacheHitTokens / denominator : undefined;
  }
  if (typeof input.inputTokens === "number" && Number.isFinite(input.inputTokens) && input.inputTokens > 0) {
    return input.cacheHitTokens / input.inputTokens;
  }
  return undefined;
}

function finiteNumberOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}


function ensureColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  if (!columns.some((entry) => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function normalizeProviderURL(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
    return `${url.origin}${path}`;
  } catch {
    return undefined;
  }
}

function canonicalPriceJson(price: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(price).sort(([left], [right]) => left.localeCompare(right))));
}

function transaction(db: DatabaseSync, fn: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    fn();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function tokenUsageSelect(suffix: string): string {
  return `
    SELECT
      event.id AS id,
      created_at AS createdAt,
      created_at_utc AS createdAtUtc,
      agent_id AS agentId,
      model,
      session_id AS sessionId,
      request_id AS requestId,
      response_id AS responseId,
      input_tokens AS inputTokens,
      output_tokens AS outputTokens,
      total_tokens AS totalTokens,
      cache_hit_tokens AS cacheHitTokens,
      cache_miss_tokens AS cacheMissTokens,
      cache_hit_rate AS cacheHitRate,
      finish_reason AS finishReason,
      raw_usage_json AS rawUsageJson,
      event.provider_id AS providerId,
      ${eventCostExpression()} AS costUsd
    FROM ${tokenUsageFrom()}
    ${suffix}
  `;
}

function eventCostExpression(): string {
  return `(COALESCE(event.cache_hit_tokens, 0) * COALESCE(price.cache_read_per_mtok, price.input_per_mtok)
    + COALESCE(event.cache_miss_tokens, MAX(0, COALESCE(event.input_tokens, 0) - COALESCE(event.cache_hit_tokens, 0))) * price.input_per_mtok
    + COALESCE(event.output_tokens, 0) * price.output_per_mtok) / 1000000.0`;
}

function tokenUsageFrom(): string {
  return `token_usage_events event
    LEFT JOIN llm_model_price_timeline price ON price.id = (
      SELECT observed.id
      FROM llm_model_price_timeline observed
      WHERE observed.provider_id = event.provider_id
        AND observed.model_id = event.model
        AND observed.first_seen_at_utc <= event.created_at_utc
      ORDER BY observed.first_seen_at_utc DESC, observed.id DESC
      LIMIT 1
    )`;
}

function rowToEvent(row: any): StoredTokenUsageEvent {
  return {
    id: Number(row.id),
    createdAt: row.createdAt,
    createdAtUtc: optionalString(row.createdAtUtc),
    agentId: row.agentId,
    model: optionalString(row.model),
    sessionId: optionalScalar(row.sessionId),
    requestId: optionalNumber(row.requestId),
    responseId: optionalNumber(row.responseId),
    inputTokens: optionalNumber(row.inputTokens),
    outputTokens: optionalNumber(row.outputTokens),
    totalTokens: optionalNumber(row.totalTokens),
    cacheHitTokens: optionalNumber(row.cacheHitTokens),
    cacheMissTokens: optionalNumber(row.cacheMissTokens),
    cacheHitRate: optionalNumber(row.cacheHitRate),
    finishReason: optionalString(row.finishReason),
    rawUsageJson: optionalString(row.rawUsageJson),
    providerId: optionalString(row.providerId),
    costUsd: optionalNumber(row.costUsd)
  };
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** LLM 会话 id 已改为字符串; 兼容旧记录里的数字 id, 原样返回数字或字符串。 */
function optionalScalar(value: unknown): number | string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
