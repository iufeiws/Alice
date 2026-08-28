import type { AgentEvent } from "../../../agent-loop/src/contracts/agent-contracts.js";
import type { ToolCall, ToolDefinition, ToolPlugin, ToolResult } from "../../../tool-execution/src/index.js";
import type { LLMChatInput } from "../../../llm-gateway/src/index.js";
import { buildLayerMessagesWithToolResults, promptRenderer, type PromptProfile, type PromptRenderContext } from "../../../../contexts/agent-profile/src/application/build-system-prompt.js";
import { normalizePromptLayer, type PromptLayer, type PromptMessage } from "../../../../contexts/agent-profile/src/domain/prompt-layer.js";

const fs = await import("node:fs");
const path = await import("node:path");
const sqlite = await import("../../../../platform/storage/src/sqlite-compat.js");

export type AgentInitiatedBehaviorKind = "event" | "randomized";
export type AgentInitiatedBehaviorPriority = number;
export type AgentInitiatedBehaviorStep =
  | {
      kind: "backend_effect";
      effect: "sleep_cocoon";
      arguments: Record<string, unknown>;
    }
  | {
      kind: "llm_instruction";
      promptProfilePath: string;
    }
  | {
      kind: "record_only";
      reason: string;
    };

export type AgentInitiatedBehaviorPlan = {
  id: string;
  custom?: boolean;
  kind: AgentInitiatedBehaviorKind;
  enabled: boolean;
  triggerEvent?: string;
  weight?: number;
  priority?: AgentInitiatedBehaviorPriority;
  dryRun?: boolean;
  promptProfilePath?: string;
  steps: AgentInitiatedBehaviorStep[];
};

export type AgentInitiatedBehaviorPromptProfile = PromptLayer;

export type AgentInitiatedBehaviorRun = {
  id: string;
  behaviorId: string;
  kind: AgentInitiatedBehaviorKind;
  triggeredAt: string;
  triggeredAtUtc?: string;
  trigger: string;
  dryRun: boolean;
  result: "completed" | "skipped" | "dry_run" | "failed";
  sessionId?: string;
  respondedWithin15m?: boolean;
  steps: Array<{
    kind: AgentInitiatedBehaviorStep["kind"];
    result: "completed" | "skipped" | "failed";
    error?: string;
  }>;
  error?: string;
};

export type AgentInitiatedBehaviorRunStore = {
  record(run: AgentInitiatedBehaviorRun): AgentInitiatedBehaviorRun;
  list(limit?: number): AgentInitiatedBehaviorRun[];
  markRespondedWithin15m(input: { sessionId: string; respondedAt: string | Date }): number;
  finalizeExpiredResponses(now?: Date): number;
  randomThirtyMinuteBuckets(now?: Date): Array<{
    startAt: string;
    total: number;
    respondedWithin15m: number;
    notRespondedWithin15m: number;
  }>;
};

export type AgentInitiatedBehaviorAvailability = {
  status: "available" | "unavailable";
  reason?: string;
  steps: Array<{
    kind: AgentInitiatedBehaviorStep["kind"];
    status: "available" | "unavailable";
    reason?: string;
  }>;
};

export type AgentInitiatedBehaviorRunStoreOptions = {
  dbPath?: string;
  filePath?: string;
  limit?: number;
};

const responseWindowMs = 15 * 60 * 1000;
export const defaultAgentInitiatedBehaviorPlans: AgentInitiatedBehaviorPlan[] = [
  {
    id: "sleep_goodnight",
    kind: "event",
    enabled: true,
    triggerEvent: "sleep_cocoon.auto_goodnight_check",
    promptProfilePath: "src/contexts/initiative/behaviors/sleep_goodnight.json",
    steps: [
      { kind: "llm_instruction", promptProfilePath: "src/contexts/initiative/behaviors/sleep_goodnight.json" }
    ]
  },
  {
    id: "sleep_morning",
    kind: "event",
    enabled: true,
    triggerEvent: "sleep_cocoon.wake",
    promptProfilePath: "src/contexts/initiative/behaviors/sleep_morning.json",
    steps: [{ kind: "llm_instruction", promptProfilePath: "src/contexts/initiative/behaviors/sleep_morning.json" }]
  },
  {
    id: "sleep_force_wake",
    kind: "event",
    enabled: true,
    triggerEvent: "sleep_cocoon.force_wake",
    promptProfilePath: "src/contexts/initiative/behaviors/sleep_force_wake.json",
    steps: [{ kind: "llm_instruction", promptProfilePath: "src/contexts/initiative/behaviors/sleep_force_wake.json" }]
  },
  {
    id: "calendar_reminder",
    kind: "event",
    enabled: true,
    triggerEvent: "calendar.schedule_due",
    promptProfilePath: "src/contexts/initiative/behaviors/calendar_reminder.json",
    steps: [{ kind: "llm_instruction", promptProfilePath: "src/contexts/initiative/behaviors/calendar_reminder.json" }]
  }
];

export function agentInitiatedBehaviorPlanFromEvent(
  event: AgentEvent,
  plans: AgentInitiatedBehaviorPlan[] = defaultAgentInitiatedBehaviorPlans,
  random: () => number = Math.random
): AgentInitiatedBehaviorPlan | undefined {
  const triggerEvent = agentInitiatedTriggerEventFromRaw(event.meta.raw);
  if (!triggerEvent) return undefined;
  if (triggerEvent === "randomized") return selectRandomizedAgentInitiatedBehaviorPlan(plans, random);
  return plans.find((plan) => plan.kind === "event" && plan.enabled && plan.triggerEvent === triggerEvent);
}

export function agentInitiatedTriggerEventFromRaw(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const triggerEvent = (raw as { agentInitiatedTriggerEvent?: unknown }).agentInitiatedTriggerEvent;
  return typeof triggerEvent === "string" && triggerEvent ? triggerEvent : undefined;
}

export function selectRandomizedAgentInitiatedBehaviorPlan(
  plans: AgentInitiatedBehaviorPlan[] = defaultAgentInitiatedBehaviorPlans,
  random: () => number = Math.random
): AgentInitiatedBehaviorPlan | undefined {
  const candidates = randomizedAgentInitiatedBehaviorPlans(plans);
  const totalWeight = candidates.reduce((total, plan) => total + (plan.weight ?? 0), 0);
  if (totalWeight <= 0) return undefined;
  let roll = random() * totalWeight;
  for (const plan of candidates) {
    roll -= plan.weight ?? 0;
    if (roll < 0) return plan;
  }
  return candidates.at(-1);
}

export function hasRandomizedAgentInitiatedBehaviorPlan(
  plans: AgentInitiatedBehaviorPlan[] = defaultAgentInitiatedBehaviorPlans
): boolean {
  return randomizedAgentInitiatedBehaviorPlans(plans).length > 0;
}

function randomizedAgentInitiatedBehaviorPlans(plans: AgentInitiatedBehaviorPlan[]): AgentInitiatedBehaviorPlan[] {
  return plans.filter((plan) => (
    plan.kind === "randomized"
    && plan.enabled
    && plan.dryRun !== true
    && typeof plan.weight === "number"
    && Number.isFinite(plan.weight)
    && plan.weight > 0
  ));
}

export async function buildAgentInitiatedBehaviorMessages(
  plan: AgentInitiatedBehaviorPlan | undefined,
  _promptProfile: PromptProfile,
  context: PromptRenderContext,
  runTool: (message: PromptMessage, call: ToolCall) => Promise<ToolResult>,
  getToolDefinition?: (toolName: string) => ToolDefinition | undefined
): Promise<LLMChatInput["messages"]> {
  if (!plan || !plan.enabled || plan.dryRun) return [];
  const renderer = promptRenderer(context);
  const messages: LLMChatInput["messages"] = [];
  for (const step of plan.steps) {
    if (step.kind !== "llm_instruction") continue;
    const layer = readAgentInitiatedBehaviorPromptProfile(step.promptProfilePath);
    if (!layer) throw new Error(`initiated_behavior_prompt_profile_not_found:${plan.id}`);
    messages.push(...await buildLayerMessagesWithToolResults(layer, renderer, context, runTool, getToolDefinition));
  }
  return messages;
}

export function readAgentInitiatedBehaviorPromptProfile(filePath: string): AgentInitiatedBehaviorPromptProfile | undefined {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  if (!fs.existsSync(resolved)) return undefined;
  return normalizeAgentInitiatedBehaviorPromptProfile(JSON.parse(fs.readFileSync(resolved, "utf8")));
}

export function defaultAgentInitiatedBehaviorPromptProfile(_id: string): AgentInitiatedBehaviorPromptProfile {
  return { meta: {}, messages: [] };
}

export function normalizeAgentInitiatedBehaviorPromptProfile(value: unknown): AgentInitiatedBehaviorPromptProfile {
  return normalizePromptLayer(value);
}

export function resolveAgentInitiatedBehaviorAvailability(
  plan: AgentInitiatedBehaviorPlan,
  promptProfile: PromptProfile,
  tools: ToolPlugin[]
): AgentInitiatedBehaviorAvailability {
  const steps = plan.steps.map((step) => {
    if (step.kind === "llm_instruction") {
      const layer = readAgentInitiatedBehaviorPromptProfile(step.promptProfilePath);
      if (!layer) return { kind: step.kind, status: "unavailable" as const, reason: "prompt_profile_missing" };
      const unavailableTool = layer.messages
        .filter((message) => message.meta.enabled && message.role === "assistant")
        .flatMap((message) => (message.toolCalls ?? []).map((call) => call.function.name))
        .find((toolName) => !isToolVisibleInPromptProfile(promptProfile, toolName) || !findToolByName(tools, toolName));
      if (!unavailableTool) return { kind: step.kind, status: "available" as const };
      const reason = !isToolVisibleInPromptProfile(promptProfile, unavailableTool)
        ? `tool_hidden:${unavailableTool}`
        : `tool_missing:${unavailableTool}`;
      return { kind: step.kind, status: "unavailable" as const, reason };
    }
    if (step.kind !== "backend_effect") return { kind: step.kind, status: "available" as const };
    if (step.effect !== "sleep_cocoon") {
      return { kind: step.kind, status: "unavailable" as const, reason: `unsupported_backend_effect:${step.effect}` };
    }
    if (!isToolVisibleInPromptProfile(promptProfile, "sleep_cocoon")) {
      return { kind: step.kind, status: "unavailable" as const, reason: "tool_hidden:sleep_cocoon" };
    }
    if (!findToolByName(tools, "sleep_cocoon")) {
      return { kind: step.kind, status: "unavailable" as const, reason: "tool_missing:sleep_cocoon" };
    }
    return { kind: step.kind, status: "available" as const };
  });
  const unavailable = steps.find((step) => step.status === "unavailable");
  return {
    status: unavailable ? "unavailable" : "available",
    reason: unavailable?.reason,
    steps
  };
}

export function isToolVisibleInPromptProfile(promptProfile: PromptProfile, toolName: string): boolean {
  const visibleTools = promptProfile.visibleTools as Record<string, unknown>;
  if (toolName === "messaging" || toolName === "Chat" || toolName === "finish_and_wait") {
    return visibleTools.feishu !== false && visibleTools[toolName] !== false;
  }
  if (toolName === "photo" || toolName === "media") {
    return visibleTools.photo !== false && visibleTools.media !== false && visibleTools[toolName] !== false;
  }
  if (toolName === "shell") {
    return visibleTools.shell !== false;
  }
  return visibleTools[toolName] !== false;
}

export function createAgentInitiatedBehaviorRunStore(options: number | AgentInitiatedBehaviorRunStoreOptions = 1_000): AgentInitiatedBehaviorRunStore {
  const limit = typeof options === "number" ? options : options.limit ?? 1_000;
  const dbPath = typeof options === "number" ? undefined : options.dbPath ?? options.filePath;
  if (dbPath) return createSqliteAgentInitiatedBehaviorRunStore(dbPath, limit);
  return createMemoryAgentInitiatedBehaviorRunStore(limit);
}

function createMemoryAgentInitiatedBehaviorRunStore(limit: number): AgentInitiatedBehaviorRunStore {
  const runs: AgentInitiatedBehaviorRun[] = [];
  const finalize = (now = new Date()): number => {
    let count = 0;
    const nowMs = now.getTime();
    for (const run of runs) {
      if (run.respondedWithin15m !== undefined) continue;
      if (run.result !== "completed") continue;
      const triggeredAt = runTriggeredTimestamp(run);
      if (!Number.isFinite(triggeredAt)) continue;
      if (nowMs - triggeredAt <= responseWindowMs) continue;
      run.respondedWithin15m = false;
      count += 1;
    }
    return count;
  };
  return {
    record(run) {
      runs.unshift(run);
      if (runs.length > limit) runs.length = limit;
      return run;
    },
    list(count = 100) {
      return runs.slice(0, Math.max(0, Math.floor(count)));
    },
    markRespondedWithin15m(input) {
      const respondedAt = input.respondedAt instanceof Date ? input.respondedAt : new Date(input.respondedAt);
      const respondedAtMs = respondedAt.getTime();
      if (!Number.isFinite(respondedAtMs)) return 0;
      let count = 0;
      for (const run of runs) {
        if (run.sessionId !== input.sessionId) continue;
        if (run.respondedWithin15m !== undefined) continue;
        if (run.result !== "completed") continue;
        const triggeredAt = runTriggeredTimestamp(run);
        if (!Number.isFinite(triggeredAt)) continue;
        if (respondedAtMs < triggeredAt || respondedAtMs - triggeredAt > responseWindowMs) continue;
        run.respondedWithin15m = true;
        count += 1;
      }
      return count;
    },
    finalizeExpiredResponses(now = new Date()) {
      return finalize(now);
    },
    randomThirtyMinuteBuckets(now = new Date()) {
      finalize(now);
      const bucketCount = 48;
      const bucketMs = 30 * 60 * 1000;
      const end = Math.floor(now.getTime() / bucketMs) * bucketMs + bucketMs;
      return Array.from({ length: bucketCount }, (_, index) => {
        const start = end - (bucketCount - index) * bucketMs;
        const stop = start + bucketMs;
        const bucketRuns = runs.filter((run) => {
          const timestamp = runTriggeredTimestamp(run);
          return run.kind === "randomized" && Number.isFinite(timestamp) && timestamp >= start && timestamp < stop && run.result === "completed";
        });
        const respondedWithin15m = bucketRuns.filter((run) => run.respondedWithin15m === true).length;
        const notRespondedWithin15m = bucketRuns.filter((run) => run.respondedWithin15m === false).length;
        return {
          startAt: new Date(start).toISOString(),
          total: bucketRuns.length,
          respondedWithin15m,
          notRespondedWithin15m
        };
      });
    }
  };
}

function createSqliteAgentInitiatedBehaviorRunStore(dbPath: string, limit: number): AgentInitiatedBehaviorRunStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db: any = new sqlite.DatabaseSync(dbPath);
  initializeRunDb(db);
  return {
    record(run) {
      db.prepare(`
        INSERT OR REPLACE INTO initiated_behavior_runs(
          id, behavior_id, kind, triggered_at, triggered_at_utc, trigger, dry_run, result,
          session_id, responded_within_15m, steps_json, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.id,
        run.behaviorId,
        run.kind,
        run.triggeredAt,
        run.triggeredAtUtc ?? null,
        run.trigger,
        run.dryRun ? 1 : 0,
        run.result,
        run.sessionId ?? null,
        booleanToSql(run.respondedWithin15m),
        JSON.stringify(run.steps ?? []),
        run.error ?? null
      );
      pruneRuns(db, limit);
      return run;
    },
    list(count = 100) {
      return db.prepare(`
        SELECT ${runSelectColumns()}
        FROM initiated_behavior_runs
        ORDER BY COALESCE(triggered_at_utc, triggered_at) DESC, rowid DESC
        LIMIT ?
      `).all(Math.max(0, Math.floor(count))).map(rowToRun).filter(Boolean);
    },
    markRespondedWithin15m(input) {
      const respondedAt = input.respondedAt instanceof Date ? input.respondedAt : new Date(input.respondedAt);
      const respondedAtMs = respondedAt.getTime();
      if (!Number.isFinite(respondedAtMs)) return 0;
      const rows = db.prepare(`
        SELECT id, COALESCE(triggered_at_utc, triggered_at) AS triggeredAt
        FROM initiated_behavior_runs
        WHERE session_id = ?
          AND result = 'completed'
          AND responded_within_15m IS NULL
      `).all(input.sessionId);
      const ids = rows
        .filter((row: { id: string; triggeredAt: string }) => {
          const triggeredAt = Date.parse(row.triggeredAt);
          return Number.isFinite(triggeredAt)
            && respondedAtMs >= triggeredAt
            && respondedAtMs - triggeredAt <= responseWindowMs;
        })
        .map((row: { id: string }) => row.id);
      if (ids.length === 0) return 0;
      const update = db.prepare("UPDATE initiated_behavior_runs SET responded_within_15m = 1 WHERE id = ?");
      for (const id of ids) update.run(id);
      return ids.length;
    },
    finalizeExpiredResponses(now = new Date()) {
      const nowMs = now.getTime();
      if (!Number.isFinite(nowMs)) return 0;
      const rows = db.prepare(`
        SELECT id, COALESCE(triggered_at_utc, triggered_at) AS triggeredAt
        FROM initiated_behavior_runs
        WHERE result = 'completed'
          AND responded_within_15m IS NULL
      `).all();
      const ids = rows
        .filter((row: { id: string; triggeredAt: string }) => {
          const triggeredAt = Date.parse(row.triggeredAt);
          return Number.isFinite(triggeredAt) && nowMs - triggeredAt > responseWindowMs;
        })
        .map((row: { id: string }) => row.id);
      if (ids.length === 0) return 0;
      const update = db.prepare("UPDATE initiated_behavior_runs SET responded_within_15m = 0 WHERE id = ?");
      for (const id of ids) update.run(id);
      return ids.length;
    },
    randomThirtyMinuteBuckets(now = new Date()) {
      this.finalizeExpiredResponses(now);
      const bucketCount = 48;
      const bucketMs = 30 * 60 * 1000;
      const end = Math.floor(now.getTime() / bucketMs) * bucketMs + bucketMs;
      const randomizedRuns = db.prepare(`
        SELECT COALESCE(triggered_at_utc, triggered_at) AS triggeredAt, responded_within_15m AS respondedWithin15m
        FROM initiated_behavior_runs
        WHERE kind = 'randomized'
          AND result = 'completed'
      `).all();
      return Array.from({ length: bucketCount }, (_, index) => {
        const start = end - (bucketCount - index) * bucketMs;
        const stop = start + bucketMs;
        const bucketRuns = randomizedRuns.filter((run: { triggeredAt: string }) => {
          const timestamp = Date.parse(run.triggeredAt);
          return Number.isFinite(timestamp) && timestamp >= start && timestamp < stop;
        });
        const respondedWithin15m = bucketRuns.filter((run: { respondedWithin15m: number | null }) => run.respondedWithin15m === 1).length;
        const notRespondedWithin15m = bucketRuns.filter((run: { respondedWithin15m: number | null }) => run.respondedWithin15m === 0).length;
        return {
          startAt: new Date(start).toISOString(),
          total: bucketRuns.length,
          respondedWithin15m,
          notRespondedWithin15m
        };
      });
    }
  };
}

export function createAgentInitiatedBehaviorRun(input: {
  plan: AgentInitiatedBehaviorPlan;
  triggeredAt: string;
  triggeredAtUtc?: string;
  trigger: string;
  result: AgentInitiatedBehaviorRun["result"];
  sessionId?: string;
  steps?: AgentInitiatedBehaviorRun["steps"];
  error?: string;
}): AgentInitiatedBehaviorRun {
  return {
    id: `initiated_behavior_${Date.parse(input.triggeredAt) || Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    behaviorId: input.plan.id,
    kind: input.plan.kind,
    triggeredAt: input.triggeredAt,
    triggeredAtUtc: input.triggeredAtUtc,
    trigger: input.trigger,
    dryRun: input.plan.dryRun === true,
    result: input.result,
    sessionId: input.sessionId,
    steps: input.steps ?? [],
    error: input.error
  };
}

function findToolByName(tools: ToolPlugin[], toolName: string): ToolPlugin | undefined {
  return tools.find((plugin) => plugin.listTools().some((tool) => tool.name === toolName));
}

function initializeRunDb(db: any): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS initiated_behavior_runs (
      id TEXT PRIMARY KEY,
      behavior_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      triggered_at TEXT NOT NULL,
      triggered_at_utc TEXT,
      trigger TEXT NOT NULL,
      dry_run INTEGER NOT NULL,
      result TEXT NOT NULL,
      session_id TEXT,
      responded_within_15m INTEGER,
      steps_json TEXT NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS initiated_behavior_runs_triggered_at_idx ON initiated_behavior_runs(triggered_at);
    CREATE INDEX IF NOT EXISTS initiated_behavior_runs_behavior_idx ON initiated_behavior_runs(behavior_id, triggered_at);
    CREATE INDEX IF NOT EXISTS initiated_behavior_runs_session_response_idx ON initiated_behavior_runs(session_id, responded_within_15m, triggered_at);
    CREATE INDEX IF NOT EXISTS initiated_behavior_runs_random_bucket_idx ON initiated_behavior_runs(kind, result, triggered_at);
    CREATE INDEX IF NOT EXISTS initiated_behavior_runs_triggered_at_utc_idx ON initiated_behavior_runs(triggered_at_utc);
  `);
}

function pruneRuns(db: any, limit: number): void {
  if (!Number.isFinite(limit) || limit <= 0) return;
  db.prepare(`
    DELETE FROM initiated_behavior_runs
    WHERE id NOT IN (
      SELECT id
      FROM initiated_behavior_runs
      ORDER BY COALESCE(triggered_at_utc, triggered_at) DESC, rowid DESC
      LIMIT ?
    )
  `).run(Math.max(0, Math.floor(limit)));
}

function runSelectColumns(): string {
  return [
    "id",
    "behavior_id AS behaviorId",
    "kind",
    "triggered_at AS triggeredAt",
    "triggered_at_utc AS triggeredAtUtc",
    "trigger",
    "dry_run AS dryRun",
    "result",
    "session_id AS sessionId",
    "responded_within_15m AS respondedWithin15m",
    "steps_json AS stepsJson",
    "error"
  ].join(", ");
}

function rowToRun(row: unknown): AgentInitiatedBehaviorRun | undefined {
  if (!row || typeof row !== "object") return undefined;
  const value = row as Record<string, unknown>;
  let steps: unknown = [];
  try {
    steps = typeof value.stepsJson === "string" ? JSON.parse(value.stepsJson) : [];
  } catch {
    steps = [];
  }
  return normalizeRun({
    id: value.id,
    behaviorId: value.behaviorId,
    kind: value.kind,
    triggeredAt: value.triggeredAt,
    triggeredAtUtc: value.triggeredAtUtc,
    trigger: value.trigger,
    dryRun: value.dryRun === 1 || value.dryRun === true,
    result: value.result,
    sessionId: value.sessionId,
    respondedWithin15m: sqlToBoolean(value.respondedWithin15m),
    steps,
    error: value.error
  });
}

function booleanToSql(value: boolean | undefined): number | null {
  if (value === true) return 1;
  if (value === false) return 0;
  return null;
}

function sqlToBoolean(value: unknown): boolean | undefined {
  if (value === 1 || value === true) return true;
  if (value === 0 || value === false) return false;
  return undefined;
}

function normalizeRun(value: unknown): AgentInitiatedBehaviorRun | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<AgentInitiatedBehaviorRun>;
  if (typeof raw.id !== "string" || typeof raw.behaviorId !== "string" || typeof raw.triggeredAt !== "string") return undefined;
  if (raw.kind !== "event" && raw.kind !== "randomized") return undefined;
  if (raw.result !== "completed" && raw.result !== "skipped" && raw.result !== "dry_run" && raw.result !== "failed") return undefined;
  return {
    id: raw.id,
    behaviorId: raw.behaviorId,
    kind: raw.kind,
    triggeredAt: raw.triggeredAt,
    triggeredAtUtc: typeof raw.triggeredAtUtc === "string" ? raw.triggeredAtUtc : undefined,
    trigger: typeof raw.trigger === "string" ? raw.trigger : raw.behaviorId,
    dryRun: raw.dryRun === true,
    result: raw.result,
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : undefined,
    respondedWithin15m: typeof raw.respondedWithin15m === "boolean" ? raw.respondedWithin15m : undefined,
    steps: Array.isArray(raw.steps) ? raw.steps.filter((step) => (
      step
      && typeof step === "object"
      && ((step as { kind?: unknown }).kind === "backend_effect" || (step as { kind?: unknown }).kind === "llm_instruction" || (step as { kind?: unknown }).kind === "record_only")
      && ((step as { result?: unknown }).result === "completed" || (step as { result?: unknown }).result === "skipped" || (step as { result?: unknown }).result === "failed")
    )) as AgentInitiatedBehaviorRun["steps"] : [],
    error: typeof raw.error === "string" ? raw.error : undefined
  };
}

function runTriggeredTimestamp(run: Pick<AgentInitiatedBehaviorRun, "triggeredAt" | "triggeredAtUtc">): number {
  const timestamp = Date.parse(run.triggeredAtUtc ?? run.triggeredAt);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}
