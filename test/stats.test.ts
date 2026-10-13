import { describe, expect, it } from "vitest";
import { bootstrapMeanCi, cohensKappa, mcnemarExact, noiseFloor, passAtK, passHatK, percentile, variance, wilson } from "../src/eval/stats.js";

describe("statistics", () => {
  it("Wilson interval matches known values and stays in [0, 1]", () => {
    const w = wilson(8, 10);
    expect(w.lo).toBeCloseTo(0.4902, 3);
    expect(w.hi).toBeCloseTo(0.9433, 3);
    expect(wilson(10, 10).hi).toBe(1);
    expect(wilson(0, 10).lo).toBe(0);
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 });
  });

  it("percentile interpolates linearly", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50], 95)).toBeCloseTo(48);
  });

  it("pass@k and pass^k", () => {
    expect(passAtK(3, 1, 1)).toBeCloseTo(1 / 3);
    expect(passAtK(3, 1, 3)).toBe(1);
    expect(passAtK(3, 0, 3)).toBe(0);
    expect(passHatK(3, 2, 3)).toBe(0);
    expect(passHatK(3, 3, 3)).toBe(1);
    expect(passHatK(3, 2, 1)).toBeCloseTo(2 / 3);
  });

  it("exact McNemar: 5 vs 0 discordant cases is p = 0.0625, 4 vs 1 is 0.375", () => {
    expect(mcnemarExact(0, 5)).toBeCloseTo(0.0625);
    expect(mcnemarExact(1, 4)).toBeCloseTo(0.375);
    expect(mcnemarExact(0, 6)).toBeCloseTo(0.03125);
    expect(mcnemarExact(0, 0)).toBe(1);
  });

  it("Cohen's kappa", () => {
    expect(cohensKappa([["a", "a"], ["b", "b"], ["a", "a"], ["b", "b"]])).toBe(1);
    // classic textbook example: 20 yes/yes, 5 yes/no, 10 no/yes, 15 no/no -> kappa 0.4
    const pairs: [string, string][] = [
      ...Array<[string, string]>(20).fill(["y", "y"]),
      ...Array<[string, string]>(5).fill(["y", "n"]),
      ...Array<[string, string]>(10).fill(["n", "y"]),
      ...Array<[string, string]>(15).fill(["n", "n"]),
    ];
    expect(cohensKappa(pairs)).toBeCloseTo(0.4);
  });

  it("bootstrap CI is reproducible and brackets the mean", () => {
    const d = [0, 0, 1, 0, 1, 0, -1, 0, 1, 0];
    const a = bootstrapMeanCi(d, { seed: 1 });
    expect(bootstrapMeanCi(d, { seed: 1 })).toEqual(a);
    expect(a.lo).toBeLessThanOrEqual(0.2);
    expect(a.hi).toBeGreaterThanOrEqual(0.2);
  });

  it("variance and noise floor", () => {
    expect(variance([1, 0, 1])).toBeCloseTo(1 / 3);
    expect(noiseFloor(25, 2)).toBeCloseTo(0.1414, 3);
  });
});
