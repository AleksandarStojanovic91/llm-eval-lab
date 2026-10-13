/**
 * Small, dependency-free statistics used by the metrics, the comparison and the judge calibration.
 * See docs/statistics.md for why each method was chosen.
 */

/** Deterministic PRNG (mulberry32) so bootstrap intervals are reproducible run to run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample variance (n - 1). Zero for fewer than two values. */
export function variance(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
}

/** Linear-interpolation percentile (same as numpy's default). p in [0, 100]. */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = sorted[lo] ?? Number.NaN;
  const b = sorted[hi] ?? Number.NaN;
  return a + (b - a) * (rank - lo);
}

export interface Interval {
  lo: number;
  hi: number;
}

/**
 * Wilson score interval for a binomial proportion. Unlike the normal approximation it stays inside [0, 1] and
 * behaves at 0/n and n/n, which is where small eval categories usually live.
 */
export function wilson(successes: number, n: number, z = 1.96): Interval {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

export function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/** Unbiased pass@k (Chen et al. 2021): probability that at least one of k draws from n attempts with c passes passes. */
export function passAtK(n: number, c: number, k: number): number {
  if (k > n) throw new Error(`pass@k needs k <= n (k=${k}, n=${n})`);
  if (n - c < k) return 1;
  return 1 - binomial(n - c, k) / binomial(n, k);
}

/** pass^k: probability that all k draws pass. The stricter, "does it work every time" view. */
export function passHatK(n: number, c: number, k: number): number {
  if (k > n) throw new Error(`pass^k needs k <= n (k=${k}, n=${n})`);
  return binomial(c, k) / binomial(n, k);
}

/**
 * Exact two-sided McNemar test on discordant pairs: b = cases that pass only in A, c = only in B.
 * Under H0 each discordant case is a fair coin, so p = 2 * P(X <= min(b, c)), X ~ Bin(b + c, 0.5).
 */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += binomial(n, i);
  return Math.min(1, (2 * tail) / 2 ** n);
}

/** Percentile bootstrap CI for the mean of paired per-case differences, resampling cases. */
export function bootstrapMeanCi(diffs: readonly number[], opts: { iterations?: number; seed?: number; level?: number } = {}): Interval {
  if (diffs.length === 0) return { lo: Number.NaN, hi: Number.NaN };
  const iterations = opts.iterations ?? 10_000;
  const level = opts.level ?? 0.95;
  const rand = mulberry32(opts.seed ?? 20261013);
  const means: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < diffs.length; j++) sum += diffs[Math.floor(rand() * diffs.length)] ?? 0;
    means.push(sum / diffs.length);
  }
  const alpha = (1 - level) / 2;
  return { lo: percentile(means, alpha * 100), hi: percentile(means, (1 - alpha) * 100) };
}

/** Cohen's kappa for two raters over the same items with categorical labels. */
export function cohensKappa<T>(pairs: readonly (readonly [T, T])[]): number {
  const n = pairs.length;
  if (n === 0) return Number.NaN;
  const labels = [...new Set(pairs.flatMap(([a, b]) => [a, b]))];
  const observed = pairs.filter(([a, b]) => a === b).length / n;
  let expected = 0;
  for (const l of labels) {
    const pa = pairs.filter(([a]) => a === l).length / n;
    const pb = pairs.filter(([, b]) => b === l).length / n;
    expected += pa * pb;
  }
  if (expected === 1) return observed === 1 ? 1 : 0;
  return (observed - expected) / (1 - expected);
}

/** Approximate 95% half-width of a pass-rate difference you can resolve with n cases x r reps (eval-audit.md section 5). */
export function noiseFloor(n: number, reps: number): number {
  return n * reps === 0 ? Number.NaN : 1 / Math.sqrt(n * reps);
}
