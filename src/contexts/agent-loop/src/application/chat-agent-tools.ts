import type { AgentEvent, ToolPlugin } from "../contracts/agent-contracts.js";
import { createId } from "../../../../shared/uuid/src/index.js";
import { deepSeekPriceForModel } from "../../../llm-gateway/src/token-pricing.js";
import { estimateTextTokens, toolResultText } from "./run-chat-loop.js";
import { calculateTokenPressureSwitch, isTokenPressurePreviewBaseline } from "./chat-agent-token-pressure.js";
import type { LLMSessionRecord } from "./chat-agent-types.js";

export async function shouldResetSessionForTokenPressure(input: {
  session: LLMSessionRecord;
  event: AgentEvent;
  plugin: ToolPlugin | undefined;
  model: string;
  contextImportance: number;
  noteLLMSessionUpdated(session: LLMSessionRecord): void;
}): Promise<boolean> {
  const inputTokens = finiteTokenCount(input.session.lastInputTokens) ?? finiteTokenCount(input.session.lastTotalTokens);
  if (inputTokens === undefined || inputTokens <= 0) return false;
  if (!input.plugin) return false;
  const previewInput = tokenPressurePreviewInput(input.session);
  const preview = await input.plugin.execute({
    id: createId("token_pressure_preview"),
    toolName: "Chat",
    input: { action: "poll", ...previewInput },
    requester: input.event.source,
    externalSession: input.event.externalSession
  });
  if (!preview.ok) return false;
  const currentPreviewTokens = estimateTextTokens(toolResultText(preview));
  const baselineKey = tokenPressureBaselineKey(input.session, previewInput.__scope, input.model);
  const baseline = input.session.tokenPressurePreviewBaselines[baselineKey];
  if (!isTokenPressurePreviewBaseline(baseline)) {
    input.session.tokenPressurePreviewBaselines[baselineKey] = {
      inputTokens,
      previewTokens: currentPreviewTokens
    };
    input.noteLLMSessionUpdated(input.session);
    return false;
  }
  const price = deepSeekPriceForModel(input.session.lastUsageModel ?? input.model);
  const comparison = calculateTokenPressureSwitch({
    lastInputTokens: inputTokens,
    baselineInputTokens: baseline.inputTokens,
    baselinePreviewTokens: baseline.previewTokens,
    currentPreviewTokens,
    cacheHitPrice: price.hit,
    cacheMissPrice: price.miss,
    contextImportance: input.contextImportance
  });
  if (comparison.shouldReset) {
    input.session.tokenPressurePreviewBaselines[baselineKey] = {
      inputTokens: comparison.estimatedCurrentInputTokens,
      previewTokens: currentPreviewTokens
    };
    input.noteLLMSessionUpdated(input.session);
  }
  return comparison.shouldReset;
}

function finiteTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function tokenPressurePreviewInput(session: LLMSessionRecord): { __preview: true; __scope: "today" | "range"; from?: string } {
  if (session.mode === "fixed_prefix" && session.fixedPrefixStartedAt) {
    return {
      __preview: true,
      __scope: "range",
      from: session.fixedPrefixStartedAt
    };
  }
  return { __preview: true, __scope: "today" };
}

function tokenPressureBaselineKey(session: LLMSessionRecord, scope: "today" | "range", model: string): string {
  return [
    session.lastUsageModel ?? model ?? "",
    session.mode || "normal",
    scope,
    scope === "range" ? session.fixedPrefixStartedAt ?? "" : ""
  ].join("|");
}
