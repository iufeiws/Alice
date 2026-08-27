/**
 * 从保留的上游 SSE 原始日志一次性回填 Token Usage。
 *
 * 默认 dry-run；传入 --apply 后才会写入 token-usage.sqlite。每个原始 completion
 * 使用独立 source key 去重，重复执行不会重复插入。按同 model 的最近系统
 * `llm stream end` 记录关联 agent，且每条结束记录最多使用一次；无法配对的记录只进入报告。
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "../src/platform/storage/src/sqlite-compat.js";

export type TokenUsageBackfillReport = {
  discoveredUsage: number;
  matched: number;
  inserted: number;
  alreadyRecorded: number;
  unmatched: Array<{ sourceKey: string; model: string; createdAtUtc: string }>;
};

type RawUsage = {
  sourceKey: string;
  model: string;
  createdAtUtc: string;
  usage: Usage;
  finishReason?: string;
  rawUsageJson: string;
};

type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
};

type StreamEnd = {
  agentId: string;
  model: string;
  createdAt: string;
  createdAtUtc: string;
  epochMs: number;
};

const DEFAULT_MAX_MATCH_DISTANCE_MS = 60_000;

export function backfillTokenUsageFromLogs(input: {
  rawLogDir: string;
  systemLogDir: string;
  databasePath: string;
  apply?: boolean;
  maxMatchDistanceMs?: number;
}): TokenUsageBackfillReport {
  const rawUsages = readRawUsages(input.rawLogDir);
  const streamEnds = readStreamEnds(input.systemLogDir);
  const matches = matchUsages(rawUsages, streamEnds, input.maxMatchDistanceMs ?? DEFAULT_MAX_MATCH_DISTANCE_MS);
  const report: TokenUsageBackfillReport = {
    discoveredUsage: rawUsages.length,
    matched: matches.length,
    inserted: 0,
    alreadyRecorded: 0,
    unmatched: rawUsages
      .filter((usage) => !matches.some((match) => match.usage.sourceKey === usage.sourceKey))
      .map((usage) => ({ sourceKey: usage.sourceKey, model: usage.model, createdAtUtc: usage.createdAtUtc }))
  };
  if (!input.apply) return report;

  const db = new DatabaseSync(input.databasePath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS token_usage_backfill_sources (
        source_key TEXT PRIMARY KEY,
        event_id INTEGER NOT NULL,
        created_at_utc TEXT NOT NULL
      );
    `);
    for (const match of matches) {
      const source = db.prepare("SELECT 1 FROM token_usage_backfill_sources WHERE source_key = ? LIMIT 1").get(match.usage.sourceKey);
      if (source || hasEquivalentEvent(db, match)) {
        report.alreadyRecorded += 1;
        continue;
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db.prepare(`
          INSERT INTO token_usage_events(
            created_at, created_at_utc, agent_id, model,
            input_tokens, output_tokens, total_tokens, cache_hit_tokens, cache_miss_tokens,
            cache_hit_rate, finish_reason, raw_usage_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          match.end.createdAt,
          match.end.createdAtUtc,
          match.end.agentId,
          match.usage.model,
          match.usage.usage.inputTokens ?? null,
          match.usage.usage.outputTokens ?? null,
          match.usage.usage.totalTokens ?? null,
          match.usage.usage.cacheHitTokens ?? null,
          match.usage.usage.cacheMissTokens ?? null,
          cacheHitRate(match.usage.usage),
          match.usage.finishReason ?? null,
          match.usage.rawUsageJson
        );
        db.prepare(`
          INSERT INTO token_usage_backfill_sources(source_key, event_id, created_at_utc)
          VALUES (?, ?, ?)
        `).run(match.usage.sourceKey, Number(result.lastInsertRowid), match.end.createdAtUtc);
        db.exec("COMMIT");
        report.inserted += 1;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  } finally {
    db.close();
  }
  return report;
}

function readRawUsages(rawLogDir: string): RawUsage[] {
  const usages = new Map<string, RawUsage>();
  for (const filePath of collectJsonlFiles(rawLogDir)) {
    const fileText = readFileSync(filePath, "utf8");
    for (const [lineIndex, line] of fileText.split(/\r?\n/).entries()) {
      const record = parseJson(line);
      const data = parseRawData(record);
      const usage = normalizeUsage(data?.usage);
      if (!data || !usage || typeof data.model !== "string" || typeof data.created !== "number") continue;
      const sourceIdentity = `${relative(rawLogDir, filePath)}\u0000${stringValue(record?.captureId) ?? ""}\u0000${stringValue(data.id) ?? ""}\u0000${lineIndex}`;
      const sourceKey = createHash("sha256").update(sourceIdentity).digest("hex");
      usages.set(sourceKey, {
        sourceKey,
        model: data.model,
        createdAtUtc: new Date(data.created * 1000).toISOString(),
        usage,
        finishReason: stringValue(data.choices?.[0]?.finish_reason),
        rawUsageJson: JSON.stringify(data.usage)
      });
    }
  }
  return [...usages.values()].sort((left, right) => left.createdAtUtc.localeCompare(right.createdAtUtc));
}

function readStreamEnds(systemLogDir: string): StreamEnd[] {
  const ends: StreamEnd[] = [];
  for (const filePath of collectJsonlFiles(systemLogDir)) {
    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const record = parseJson(line);
      const message = stringValue(record?.message);
      const match = message && /^llm stream end: agent=([^ ]+) round=\d+ model=(.+)$/.exec(message);
      const createdAt = stringValue(record?.time);
      const createdAtUtc = stringValue(record?.utcTime);
      const epochMs = createdAtUtc ? Date.parse(createdAtUtc) : Number.NaN;
      if (!match || !createdAt || !createdAtUtc || !Number.isFinite(epochMs)) continue;
      ends.push({ agentId: match[1], model: match[2], createdAt, createdAtUtc, epochMs });
    }
  }
  return ends.sort((left, right) => left.epochMs - right.epochMs);
}

function matchUsages(usages: RawUsage[], ends: StreamEnd[], maxDistanceMs: number): Array<{ usage: RawUsage; end: StreamEnd }> {
  const usedEnds = new Set<StreamEnd>();
  const matches: Array<{ usage: RawUsage; end: StreamEnd }> = [];
  for (const usage of usages) {
    const usageEpochMs = Date.parse(usage.createdAtUtc);
    const end = ends
      .filter((candidate) => !usedEnds.has(candidate) && candidate.model === usage.model)
      .map((candidate) => ({ candidate, distance: Math.abs(candidate.epochMs - usageEpochMs) }))
      .filter((candidate) => candidate.distance <= maxDistanceMs)
      .sort((left, right) => left.distance - right.distance)[0]?.candidate;
    if (!end) continue;
    usedEnds.add(end);
    matches.push({ usage, end });
  }
  return matches;
}

function hasEquivalentEvent(db: DatabaseSync, match: { usage: RawUsage; end: StreamEnd }): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM token_usage_events
    WHERE agent_id = ? AND model = ? AND created_at_utc = ?
      AND COALESCE(input_tokens, -1) = COALESCE(?, -1)
      AND COALESCE(output_tokens, -1) = COALESCE(?, -1)
      AND COALESCE(total_tokens, -1) = COALESCE(?, -1)
    LIMIT 1
  `).get(
    match.end.agentId,
    match.usage.model,
    match.end.createdAtUtc,
    match.usage.usage.inputTokens ?? null,
    match.usage.usage.outputTokens ?? null,
    match.usage.usage.totalTokens ?? null
  );
  return row !== undefined;
}

function cacheHitRate(usage: Usage): number | null {
  if (typeof usage.cacheHitTokens !== "number" || typeof usage.cacheMissTokens !== "number") return null;
  const denominator = usage.cacheHitTokens + usage.cacheMissTokens;
  return denominator > 0 ? usage.cacheHitTokens / denominator : null;
}

function normalizeUsage(value: unknown): Usage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const inputTokens = numberValue(raw.prompt_tokens) ?? numberValue(raw.input_tokens);
  const outputTokens = numberValue(raw.completion_tokens) ?? numberValue(raw.output_tokens);
  const totalTokens = numberValue(raw.total_tokens) ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
  const details = raw.prompt_tokens_details;
  const cacheHitTokens = details && typeof details === "object" && !Array.isArray(details)
    ? numberValue((details as Record<string, unknown>).cached_tokens)
    : numberValue(raw.cache_read_input_tokens);
  const cacheMissTokens = inputTokens !== undefined && cacheHitTokens !== undefined ? Math.max(0, inputTokens - cacheHitTokens) : undefined;
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return { inputTokens, outputTokens, totalTokens, cacheHitTokens, cacheMissTokens };
}

function collectJsonlFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory() ? collectJsonlFiles(join(root, entry.name)) : entry.name.endsWith(".jsonl") ? [join(root, entry.name)] : [])
    .sort();
}

function parseRawData(record: Record<string, unknown> | undefined): Record<string, any> | undefined {
  const data = stringValue(record?.data) ?? stringValue(record?.rawLine)?.replace(/^data:\s*/, "");
  return parseJson(data);
}

function parseJson(value: string | undefined): Record<string, any> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, any> : undefined;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function main(): void {
  const apply = process.argv.includes("--apply");
  const root = resolve(process.cwd());
  const report = backfillTokenUsageFromLogs({
    rawLogDir: join(root, "logs/llm-raw"),
    systemLogDir: join(root, "logs/system"),
    databasePath: join(root, "logs/token_usage/token-usage.sqlite"),
    apply
  });
  process.stdout.write(`${JSON.stringify({ ...report, unmatched: report.unmatched.length }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
