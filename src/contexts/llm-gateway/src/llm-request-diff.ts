export type LLMRequestDiff = {
  sameAsPrevious: boolean;
  firstDiffPath?: string;
  previousValue?: unknown;
  currentValue?: unknown;
  commonPrefixChars?: number;
  roughCommonPrefixTokens?: number;
  valueDiffIndex?: number;
  roughValuePrefixTokens?: number;
  previousExcerpt?: string;
  currentExcerpt?: string;
};

export function diffRequests(previous: unknown, current: unknown): LLMRequestDiff {
  const first = firstDiff(previous, current, "$");
  const previousText = stableStringify(previous);
  const currentText = stableStringify(current);
  const valueDiff = first ? diffValueExcerpt(first.previousValue, first.currentValue) : undefined;
  return {
    sameAsPrevious: !first,
    firstDiffPath: first?.path,
    previousValue: first?.previousValue,
    currentValue: first?.currentValue,
    commonPrefixChars: commonPrefixLength(previousText, currentText),
    roughCommonPrefixTokens: estimateDeepSeekTokens(previousText.slice(0, commonPrefixLength(previousText, currentText))),
    valueDiffIndex: valueDiff?.index,
    roughValuePrefixTokens: valueDiff ? estimateDeepSeekTokens(valueTextPrefix(first?.previousValue, valueDiff.index)) : undefined,
    previousExcerpt: valueDiff?.previousExcerpt,
    currentExcerpt: valueDiff?.currentExcerpt
  };
}

function firstDiff(previous: unknown, current: unknown, path: string): { path: string; previousValue: unknown; currentValue: unknown } | undefined {
  if (Object.is(previous, current)) return undefined;
  if (!previous || !current || typeof previous !== "object" || typeof current !== "object") {
    return { path, previousValue: previous, currentValue: current };
  }
  if (Array.isArray(previous) || Array.isArray(current)) {
    if (!Array.isArray(previous) || !Array.isArray(current)) return { path, previousValue: previous, currentValue: current };
    const length = Math.max(previous.length, current.length);
    for (let index = 0; index < length; index += 1) {
      if (index >= previous.length || index >= current.length) return { path: `${path}[${index}]`, previousValue: previous[index], currentValue: current[index] };
      const nested = firstDiff(previous[index], current[index], `${path}[${index}]`);
      if (nested) return nested;
    }
    return undefined;
  }
  const previousRecord = previous as Record<string, unknown>;
  const currentRecord = current as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(previousRecord), ...Object.keys(currentRecord)])].sort();
  for (const key of keys) {
    if (!(key in previousRecord) || !(key in currentRecord)) return { path: `${path}.${key}`, previousValue: previousRecord[key], currentValue: currentRecord[key] };
    const nested = firstDiff(previousRecord[key], currentRecord[key], `${path}.${key}`);
    if (nested) return nested;
  }
  return undefined;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
    return Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)));
  }) ?? "";
}

function commonPrefixLength(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left[index] === right[index]) index += 1;
  return index;
}

function diffValueExcerpt(previous: unknown, current: unknown): { index: number; previousExcerpt: string; currentExcerpt: string } {
  const previousText = typeof previous === "string" ? previous : stableStringify(previous);
  const currentText = typeof current === "string" ? current : stableStringify(current);
  const index = commonPrefixLength(previousText, currentText);
  return {
    index,
    previousExcerpt: excerptAround(previousText, index),
    currentExcerpt: excerptAround(currentText, index)
  };
}

function excerptAround(text: string, index: number): string {
  const radius = 80;
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

function valueTextPrefix(value: unknown, length: number): string {
  const text = typeof value === "string" ? value : stableStringify(value);
  return text.slice(0, length);
}

function estimateDeepSeekTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    tokens += /[\u4e00-\u9fff]/.test(char) ? 0.6 : 0.3;
  }
  return Math.round(tokens);
}
