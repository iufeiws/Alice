export type TokenPressurePreviewBaseline = {
  inputTokens: number;
  previewTokens: number;
};

export type TokenPressureComparisonInput = {
  lastInputTokens: number;
  baselineInputTokens: number;
  baselinePreviewTokens: number;
  currentPreviewTokens: number;
  cacheHitPrice: number;
  cacheMissPrice: number;
  contextImportance?: number;
  minRebuildTokens?: number;
};

export type TokenPressureComparison = TokenPressureComparisonInput & {
  estimatedCurrentInputTokens: number;
  continuedTokenDelta: number;
  rebuildTokenDelta: number;
  continuedCost: number;
  rebuildCost: number;
  shouldReset: boolean;
};

export function calculateTokenPressureSwitch(input: TokenPressureComparisonInput): TokenPressureComparison {
  const minRebuildTokens = input.minRebuildTokens ?? 50;
  const contextImportance = Number.isFinite(input.contextImportance) && input.contextImportance !== undefined
    ? input.contextImportance
    : 1;
  const previewDelta = Math.max(0, input.currentPreviewTokens - input.baselinePreviewTokens);
  const estimatedCurrentInputTokens = input.baselineInputTokens + previewDelta;
  const continuedTokenDelta = Math.max(0, input.lastInputTokens - input.baselineInputTokens);
  const rebuildTokenDelta = Math.max(minRebuildTokens, estimatedCurrentInputTokens - input.baselineInputTokens);
  const continuedCost = continuedTokenDelta * input.cacheHitPrice;
  const rebuildCost = rebuildTokenDelta * input.cacheMissPrice * contextImportance;
  return {
    ...input,
    minRebuildTokens,
    contextImportance,
    estimatedCurrentInputTokens,
    continuedTokenDelta,
    rebuildTokenDelta,
    continuedCost,
    rebuildCost,
    shouldReset: continuedCost > rebuildCost
  };
}

export function isTokenPressurePreviewBaseline(value: unknown): value is TokenPressurePreviewBaseline {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<TokenPressurePreviewBaseline>;
  return typeof entry.inputTokens === "number"
    && Number.isFinite(entry.inputTokens)
    && typeof entry.previewTokens === "number"
    && Number.isFinite(entry.previewTokens);
}
