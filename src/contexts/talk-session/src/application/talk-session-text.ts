export function speechDeltaForOutput(delta: string, previousFullText: string): string {
  let parenthesisDepth = parenthesisDepthAfter(previousFullText);
  let speech = "";
  for (const char of Array.from(delta)) {
    if (char === "(" || char === "（") {
      parenthesisDepth += 1;
      continue;
    }
    if ((char === ")" || char === "）") && parenthesisDepth > 0) {
      parenthesisDepth -= 1;
      continue;
    }
    if (parenthesisDepth > 0) continue;
    speech += char;
  }
  return speech;
}

function parenthesisDepthAfter(text: string): number {
  let depth = 0;
  for (const char of Array.from(text)) {
    if (char === "(" || char === "（") depth += 1;
    else if ((char === ")" || char === "）") && depth > 0) depth -= 1;
  }
  return depth;
}

export function charLength(text: string): number {
  return Array.from(text).length;
}

export function sliceChars(text: string, start: number, end?: number): string {
  return Array.from(text).slice(start, end).join("");
}

export function splitIndexFromContext(originalText: string, context?: { beforeText?: string; afterText?: string }): number | undefined {
  const beforeText = context?.beforeText;
  const afterText = context?.afterText;
  if (!beforeText && !afterText) return undefined;
  const originalChars = Array.from(originalText);
  const beforeChars = beforeText ? Array.from(beforeText) : [];
  const afterChars = afterText ? Array.from(afterText) : [];
  for (let index = 0; index <= originalChars.length; index += 1) {
    if (beforeChars.length > 0 && !charsEndWith(originalChars, index, beforeChars)) continue;
    if (afterChars.length > 0 && !charsStartWith(originalChars, index, afterChars)) continue;
    return index;
  }
  if (beforeChars.length > 0 && afterChars.length > 0) {
    const index = charIndexBetweenContextAcrossOmittedParentheses(originalChars, beforeChars, afterChars);
    if (index !== undefined) return index;
  }
  if (beforeChars.length > 0) {
    const index = lastCharIndexOf(originalChars, beforeChars);
    if (index >= 0) return index + beforeChars.length;
  }
  if (afterChars.length > 0) {
    const index = firstCharIndexOf(originalChars, afterChars);
    if (index >= 0) return index;
  }
  return normalizedSplitIndexFromContext(originalText, context);
}

function charIndexBetweenContextAcrossOmittedParentheses(chars: string[], before: string[], after: string[]): number | undefined {
  for (let index = 0; index <= chars.length; index += 1) {
    if (!charsEndWith(chars, index, before)) continue;
    const afterIndex = skipParenthesizedAt(chars, index);
    if (afterIndex !== undefined && charsStartWith(chars, afterIndex, after)) return index;
  }
  return undefined;
}

function skipParenthesizedAt(chars: string[], index: number): number | undefined {
  const opener = chars[index];
  const closer = opener === "(" ? ")" : opener === "（" ? "）" : undefined;
  if (!closer) return undefined;
  let depth = 0;
  for (let cursor = index; cursor < chars.length; cursor += 1) {
    const char = chars[cursor];
    if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
  }
  return undefined;
}

function charsEndWith(chars: string[], endIndex: number, suffix: string[]): boolean {
  if (suffix.length > endIndex) return false;
  for (let offset = 0; offset < suffix.length; offset += 1) {
    if (chars[endIndex - suffix.length + offset] !== suffix[offset]) return false;
  }
  return true;
}

function charsStartWith(chars: string[], startIndex: number, prefix: string[]): boolean {
  if (startIndex + prefix.length > chars.length) return false;
  for (let offset = 0; offset < prefix.length; offset += 1) {
    if (chars[startIndex + offset] !== prefix[offset]) return false;
  }
  return true;
}

function firstCharIndexOf(chars: string[], needle: string[]): number {
  for (let index = 0; index <= chars.length - needle.length; index += 1) {
    if (charsStartWith(chars, index, needle)) return index;
  }
  return -1;
}

function lastCharIndexOf(chars: string[], needle: string[]): number {
  for (let index = chars.length - needle.length; index >= 0; index -= 1) {
    if (charsStartWith(chars, index, needle)) return index;
  }
  return -1;
}

function normalizedSplitIndexFromContext(originalText: string, context: { beforeText?: string; afterText?: string }): number | undefined {
  const original = normalizeForContextLookup(originalText);
  const before = context.beforeText ? normalizeForContextLookup(context.beforeText) : undefined;
  const after = context.afterText ? normalizeForContextLookup(context.afterText) : undefined;
  for (let index = 0; index <= original.text.length; index += 1) {
    if (before && !original.text.slice(0, index).endsWith(before.text)) continue;
    if (after && !original.text.slice(index).startsWith(after.text)) continue;
    return original.endIndexes[Math.max(0, index - 1)] ?? 0;
  }
  if (before) {
    const index = original.text.lastIndexOf(before.text);
    if (index >= 0) return original.endIndexes[index + before.text.length - 1] ?? 0;
  }
  if (after) {
    const index = original.text.indexOf(after.text);
    if (index >= 0) return original.startIndexes[index] ?? 0;
  }
  return undefined;
}

function normalizeForContextLookup(text: string): { text: string; startIndexes: number[]; endIndexes: number[] } {
  const chars = Array.from(text);
  let normalized = "";
  const startIndexes: number[] = [];
  const endIndexes: number[] = [];
  for (const [index, char] of chars.entries()) {
    if (/\s/u.test(char)) continue;
    const value = char === "…" ? "." : char;
    normalized += value;
    startIndexes.push(index);
    endIndexes.push(index + 1);
  }
  return { text: normalized, startIndexes, endIndexes };
}

export function ratio(elapsedMs?: number, totalMs?: number): number {
  if (!elapsedMs || !totalMs || totalMs <= 0) return 0;
  return Math.max(0, Math.min(1, elapsedMs / totalMs));
}

export function clampIndex(value: number, length: number): number {
  return Math.max(0, Math.min(length, Math.trunc(value)));
}
