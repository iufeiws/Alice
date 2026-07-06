import type { MemorySnapshot, MemoryTarget } from './model.js';
import { memoryFileLimits } from './model.js';

const fullwidthLettersAndDigits = "ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ０１２３４５６７８９";
const halfwidthLettersAndDigits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export const commonHalfwidthNormalizationMap: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(Array.from(fullwidthLettersAndDigits).map((char, index) => [char, halfwidthLettersAndDigits[index]])),
  "　": " ",
  "，": ",",
  "。": ".",
  "．": ".",
  "：": ":",
  "；": ";",
  "？": "?",
  "！": "!",
  "（": "(",
  "）": ")",
  "【": "[",
  "】": "]",
  "［": "[",
  "］": "]",
  "｛": "{",
  "｝": "}",
  "“": "\"",
  "”": "\"",
  "‘": "'",
  "’": "'",
  "／": "/",
  "＼": "\\",
  "＿": "_",
  "－": "-",
  "～": "~",
  "｜": "|",
  "＃": "#",
  "＠": "@",
  "＆": "&",
  "＊": "*",
  "＋": "+",
  "＝": "=",
  "＜": "<",
  "＞": ">"
});

export function enforceMemoryLimits(snapshot: MemorySnapshot): MemorySnapshot {
  return {
    persistent: enforceTargetLimit("persistent", snapshot.persistent),
    userPreferences: enforceTargetLimit("userPreferences", snapshot.userPreferences),
    yesterdaySummary: enforceTargetLimit("yesterdaySummary", snapshot.yesterdaySummary)
  };
}

export function normalizeCommonHalfwidthCharacters(text: string): string {
  return Array.from(text, (char) => commonHalfwidthNormalizationMap[char] ?? char).join("");
}

export function enforceTargetLimit(target: MemoryTarget, text: string): string {
  const limit = memoryFileLimits[target];
  let output = text.split(/\r?\n/).slice(0, limit.lines).join("\n").trim();
  while (utf8ByteLength(output) > limit.bytes) {
    const next = output.split(/\r?\n/).slice(0, -1).join("\n").trim();
    if (!next || next === output) break;
    output = next;
  }
  while (utf8ByteLength(output) > limit.bytes && output.length > 0) output = output.slice(0, -1);
  return output ? `${output}\n` : "";
}

export function lineCount(text: string): number {
  return text.trim() ? text.trim().split(/\r?\n/).length : 0;
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
