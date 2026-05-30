export type TokenPriceCnyPer1M = {
  pattern: string;
  hit: number;
  miss: number;
  output: number;
};

export const deepSeekPricesCnyPer1M: TokenPriceCnyPer1M[] = [
  { pattern: "deepseek-v4-pro", hit: 0.025, miss: 3, output: 6 },
  { pattern: "deepseek-v4-flash", hit: 0.02, miss: 1, output: 2 },
  { pattern: "deepseek", hit: 0.02, miss: 1, output: 2 }
];

export function deepSeekPriceForModel(model: string | undefined): TokenPriceCnyPer1M {
  const value = String(model || "");
  return deepSeekPricesCnyPer1M.find((price) => new RegExp(price.pattern, "i").test(value))
    ?? deepSeekPricesCnyPer1M[deepSeekPricesCnyPer1M.length - 1];
}
