import type { LLMChatResult } from "./index.js";
import type { TokenUsageQuery, createTokenUsageStore } from "../../../platform/storage/src/token-usage-store.js";

type TokenUsageStore = ReturnType<typeof createTokenUsageStore>;

export function createTokenUsageRuntime(input: {
  getStore(): TokenUsageStore | undefined;
  appendLog(level: "info" | "warn", message: string): void;
}) {
  return {
    recordTokenUsageEvent,
    appendLLMUsageLog,
    getTokenUsageReport
  };

  function recordTokenUsageEvent(event: {
    createdAt: string;
    createdAtUtc?: string;
    agentId: string;
    model?: string;
    sessionId?: number;
    requestId?: number;
    responseId?: number;
    result: LLMChatResult;
  }): ReturnType<TokenUsageStore["insert"]> | undefined {
    try {
      const usage = event.result.usage;
      const store = input.getStore();
      if (!store) return undefined;
      return store.insert({
        createdAt: event.createdAt,
        createdAtUtc: event.createdAtUtc,
        agentId: event.agentId,
        model: event.model,
        sessionId: event.sessionId,
        requestId: event.requestId,
        responseId: event.responseId,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        totalTokens: usage?.totalTokens,
        cacheHitTokens: usage?.cacheHitTokens,
        cacheMissTokens: usage?.cacheMissTokens,
        finishReason: event.result.finishReason,
        rawUsageJson: extractRawUsageJson(event.result.raw)
      });
    } catch (error) {
      try {
        input.appendLog("warn", `token usage persist failed: ${error instanceof Error ? error.message : String(error)}`);
      } catch {}
      return undefined;
    }
  }

  function appendLLMUsageLog(result: LLMChatResult, modelFallback: string | undefined): void {
    try {
      const rawUsage = extractRawUsage(result.raw);
      const usage = result.usage;
      if (!usage) {
        input.appendLog("info", `llm token usage: input=? output=? total=? cache_hit=? cache_miss=? model=${modelFallback} raw_usage=${rawUsage}`);
        return;
      }
      input.appendLog("info", [
        "llm token usage:",
        `input=${formatTokenCount(usage.inputTokens)}`,
        `output=${formatTokenCount(usage.outputTokens)}`,
        `total=${formatTokenCount(usage.totalTokens)}`,
        `cache_hit=${formatTokenCount(usage.cacheHitTokens)}`,
        `cache_miss=${formatTokenCount(usage.cacheMissTokens)}`,
        `model=${modelFallback}`,
        `raw_usage=${rawUsage}`
      ].join(" "));
    } catch {
      return;
    }
  }

  function getTokenUsageReport(query: TokenUsageQuery) {
    const emptyReport = {
      summary: {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        costUsd: 0
      },
      buckets: [],
      byModel: [],
      byModelBucket: [],
      latest: []
    };
    try {
      return input.getStore()?.report(query) ?? emptyReport;
    } catch {
      return emptyReport;
    }
  }
}

function extractRawUsage(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "undefined";
  const usage = (raw as { usage?: unknown }).usage;
  if (usage === undefined) return "undefined";
  try {
    return JSON.stringify(usage);
  } catch {
    return String(usage);
  }
}

function extractRawUsageJson(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = (raw as { usage?: unknown }).usage;
  if (usage === undefined) return undefined;
  try {
    return JSON.stringify(usage);
  } catch {
    return String(usage);
  }
}

function formatTokenCount(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "?";
}
