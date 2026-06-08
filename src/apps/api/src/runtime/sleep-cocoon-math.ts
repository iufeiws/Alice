export function sleepCocoonHazardProbability(previousHours: number, currentHours: number): number {
  if (currentHours <= previousHours) return 0;
  const previousCdf = normalCdf(previousHours, 24, 1);
  const currentCdf = normalCdf(currentHours, 24, 1);
  const remaining = Math.max(1e-9, 1 - previousCdf);
  return Math.max(0, Math.min(1, (currentCdf - previousCdf) / remaining));
}

function normalCdf(value: number, mean: number, standardDeviation: number): number {
  return 0.5 * (1 + erf((value - mean) / (standardDeviation * Math.SQRT2)));
}

function erf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

