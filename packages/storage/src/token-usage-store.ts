const sqlite = await import("node:sqlite");
const fs = await import("node:fs");
const path = await import("node:path");

type DatabaseSync = any;

export type TokenUsageEventInput = {
  createdAt: string;
  agentId: string;
  model?: string;
  sessionId?: number;
  requestId?: number;
  responseId?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  finishReason?: string;
  rawUsageJson?: string;
};

export type StoredTokenUsageEvent = Required<Pick<TokenUsageEventInput, "createdAt" | "agentId">> & {
  id: number;
  model?: string;
  sessionId?: number;
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

export type TokenUsageStore = {
  insert(input: TokenUsageEventInput): StoredTokenUsageEvent;
  report(query?: TokenUsageQuery): TokenUsageReport;
};

export function createTokenUsageStore(dbPath: string): TokenUsageStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db: DatabaseSync = new sqlite.DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
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
      raw_usage_json TEXT
    );

    CREATE INDEX IF NOT EXISTS token_usage_created_at_idx ON token_usage_events(created_at);
    CREATE INDEX IF NOT EXISTS token_usage_agent_model_idx ON token_usage_events(agent_id, model, created_at);
    PRAGMA user_version = 1;
  `);

  return {
    insert(input) {
      const cacheHitRate = calculateCacheHitRate(input);
      const result = db.prepare(`
        INSERT INTO token_usage_events(
          created_at, agent_id, model, session_id, request_id, response_id,
          input_tokens, output_tokens, total_tokens, cache_hit_tokens,
          cache_miss_tokens, cache_hit_rate, finish_reason, raw_usage_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.createdAt,
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
        input.rawUsageJson ?? null
      );
      return rowToEvent(db.prepare(tokenUsageSelect("WHERE id = ?")).get(Number(result.lastInsertRowid)));
    },
    report(query = {}) {
      const filter = buildFilter(query);
      const bucketExpr = query.bucket === "day"
        ? "substr(created_at, 1, 10)"
        : "substr(created_at, 1, 13) || ':00'";
      const summary = aggregateRows(db.prepare(`
        SELECT ${aggregateSelect()}
        FROM token_usage_events
        ${filter.where}
      `).get(...filter.values));
      const buckets = db.prepare(`
        SELECT ${bucketExpr} AS bucket, ${aggregateSelect()}
        FROM token_usage_events
        ${filter.where}
        GROUP BY bucket
        ORDER BY bucket ASC
      `).all(...filter.values).map((row: any) => ({ bucket: row.bucket, ...aggregateRows(row) }));
      const byModel = db.prepare(`
        SELECT COALESCE(model, 'unknown') AS model, ${aggregateSelect()}
        FROM token_usage_events
        ${filter.where}
        GROUP BY COALESCE(model, 'unknown')
        ORDER BY totalTokens DESC, requests DESC, model ASC
      `).all(...filter.values).map((row: any) => ({ model: row.model, ...aggregateRows(row) }));
      const byModelBucket = db.prepare(`
        SELECT COALESCE(model, 'unknown') AS model, ${bucketExpr} AS bucket, ${aggregateSelect()}
        FROM token_usage_events
        ${filter.where}
        GROUP BY COALESCE(model, 'unknown'), bucket
        ORDER BY model ASC, bucket ASC
      `).all(...filter.values).map((row: any) => ({ model: row.model, bucket: row.bucket, ...aggregateRows(row) }));
      const latestLimit = Math.max(1, Math.min(200, Math.trunc(query.latestLimit ?? 50)));
      const latest = db.prepare(tokenUsageSelect(`${filter.where} ORDER BY id DESC LIMIT ?`))
        .all(...filter.values, latestLimit)
        .map(rowToEvent);
      return { summary, buckets, byModel, byModelBucket, latest };
    }
  };
}

function buildFilter(query: TokenUsageQuery): { where: string; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (query.since) {
    clauses.push("created_at >= ?");
    values.push(query.since);
  }
  if (query.agentId && query.agentId !== "all") {
    clauses.push("agent_id = ?");
    values.push(query.agentId);
  }
  if (query.model && query.model !== "all") {
    clauses.push("COALESCE(model, 'unknown') = ?");
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
    COALESCE(SUM(cache_miss_tokens), 0) AS cacheMissTokens
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

function tokenUsageSelect(suffix: string): string {
  return `
    SELECT
      id,
      created_at AS createdAt,
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
      raw_usage_json AS rawUsageJson
    FROM token_usage_events
    ${suffix}
  `;
}

function rowToEvent(row: any): StoredTokenUsageEvent {
  return {
    id: Number(row.id),
    createdAt: row.createdAt,
    agentId: row.agentId,
    model: optionalString(row.model),
    sessionId: optionalNumber(row.sessionId),
    requestId: optionalNumber(row.requestId),
    responseId: optionalNumber(row.responseId),
    inputTokens: optionalNumber(row.inputTokens),
    outputTokens: optionalNumber(row.outputTokens),
    totalTokens: optionalNumber(row.totalTokens),
    cacheHitTokens: optionalNumber(row.cacheHitTokens),
    cacheMissTokens: optionalNumber(row.cacheMissTokens),
    cacheHitRate: optionalNumber(row.cacheHitRate),
    finishReason: optionalString(row.finishReason),
    rawUsageJson: optionalString(row.rawUsageJson)
  };
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
