import { describe, it, expect } from "vitest";
import {
  computeCRF,
  computeHitAt1,
  computePQI,
  exactBinomialPValue,
  computePairedComparison,
  summarizeGroup,
  type RunMetric,
} from "../src/metrics";

describe("metrics.ts pure functions", () => {
  describe("computeCRF", () => {
    it("returns 1.0 when only the mutated cell was edited", () => {
      expect(computeCRF(["cell-1"], "cell-1")).toBe(1.0);
    });

    it("returns 0.5 when 2 cells were edited including the mutated cell", () => {
      expect(computeCRF(["cell-1", "cell-2"], "cell-1")).toBe(0.5);
    });

    it("returns 0.0 when mutated cell was not edited", () => {
      expect(computeCRF(["cell-2", "cell-3"], "cell-1")).toBe(0.0);
    });

    it("returns 0.0 when no cells were edited", () => {
      expect(computeCRF([], "cell-1")).toBe(0.0);
    });
  });

  describe("computeHitAt1", () => {
    it("returns true when first edited cell is the mutated cell", () => {
      expect(computeHitAt1(["cell-1", "cell-2"], "cell-1")).toBe(true);
    });

    it("returns false when first edited cell is not the mutated cell", () => {
      expect(computeHitAt1(["cell-2", "cell-1"], "cell-1")).toBe(false);
    });

    it("returns false when no cells were edited", () => {
      expect(computeHitAt1([], "cell-1")).toBe(false);
    });
  });

  describe("computePQI fallback", () => {
    it("returns 1.0 for monolithic arm", () => {
      expect(computePQI(null, "monolithic", 2, "cell-1", ["cell-1"])).toBe(1.0);
    });

    it("estimates based on turns when target cell was edited", () => {
      expect(computePQI(null, "stepwise", 4, "cell-1", ["cell-1"])).toBe(0.5);
    });

    it("returns 1/turns when target cell was not edited", () => {
      expect(computePQI(null, "stepwise", 5, "cell-1", ["cell-2"])).toBe(0.2);
    });
  });

  describe("exactBinomialPValue (McNemar)", () => {
    it("returns 1.0 when no discordant pairs exist (0, 0)", () => {
      expect(exactBinomialPValue(0, 0)).toBe(1.0);
    });

    it("returns 1.0 when discordant pairs are symmetric (5, 5)", () => {
      expect(exactBinomialPValue(5, 5)).toBe(1.0);
    });

    it("computes exact two-tailed p-value for (0, 6)", () => {
      // 2 * (0.5)^6 = 2 * 0.015625 = 0.03125
      expect(exactBinomialPValue(0, 6)).toBeCloseTo(0.03125, 4);
    });

    it("computes exact two-tailed p-value for (1, 8)", () => {
      // 2 * (1 + 9) * 0.5^9 = 20 / 512 = 0.0390625
      expect(exactBinomialPValue(1, 8)).toBeCloseTo(0.03906, 4);
    });
  });

  describe("computePairedComparison", () => {
    it("correctly identifies discordant pairs between two arms", () => {
      const arm1Runs: RunMetric[] = [
        {
          arm: "rewind",
          mutationId: "mut-1",
          cellId: "c1",
          stratum: "value-level",
          distBand: "long",
          distanceToTerminal: 5,
          hopBand: "near",
          hopDistance: 1,
          model: "test",
          turns: 2,
          wallMs: 1000,
          promptTokens: 100,
          reasoningTokens: 50,
          answerTokens: 50,
          totalTokens: 200,
          resolved: true,
          luckyPass: false,
          resolvedGenuine: true,
          offTargetFix: false,
          protocolFailure: false,
          lengthFailure: false,
          scopeTruncated: false,
          stopReason: "finished",
          editedCells: ["c1"],
          crf: 1.0,
          hitAt1: true,
          pqi: 1.0,
        },
        {
          arm: "rewind",
          mutationId: "mut-2",
          cellId: "c2",
          stratum: "value-level",
          distBand: "long",
          distanceToTerminal: 5,
          hopBand: "near",
          hopDistance: 1,
          model: "test",
          turns: 2,
          wallMs: 1000,
          promptTokens: 100,
          reasoningTokens: 50,
          answerTokens: 50,
          totalTokens: 200,
          resolved: true,
          luckyPass: false,
          resolvedGenuine: true,
          offTargetFix: false,
          protocolFailure: false,
          lengthFailure: false,
          scopeTruncated: false,
          stopReason: "finished",
          editedCells: ["c2"],
          crf: 1.0,
          hitAt1: true,
          pqi: 1.0,
        },
      ];

      const arm2Runs: RunMetric[] = [
        {
          ...arm1Runs[0],
          arm: "stepwise",
          resolved: true,
          resolvedGenuine: true,
        },
        {
          ...arm1Runs[1],
          arm: "stepwise",
          resolved: false,
          resolvedGenuine: false,
        },
      ];

      const comparison = computePairedComparison(arm1Runs, arm2Runs, "rewind", "stepwise");
      expect(comparison.totalMutations).toBe(2);
      expect(comparison.bothResolved).toBe(1);
      expect(comparison.arm1Won).toBe(1);
      expect(comparison.arm2Won).toBe(0);
      expect(comparison.bothFailed).toBe(0);
      expect(comparison.totalDiscordant).toBe(1);
      expect(comparison.discordantRatio).toBe("1 : 0");
    });
  });

  describe("summarizeGroup", () => {
    it("handles luckyPass rate null for incidental corpus and numeric for designed corpus", () => {
      const mockRuns: RunMetric[] = [
        {
          arm: "monolithic",
          mutationId: "mut-1",
          cellId: "c1",
          stratum: "value-level",
          distBand: "direct",
          distanceToTerminal: 0,
          hopBand: "near",
          hopDistance: 1,
          model: "test",
          turns: 2,
          wallMs: 1000,
          promptTokens: 100,
          reasoningTokens: 50,
          answerTokens: 50,
          totalTokens: 200,
          resolved: true,
          luckyPass: null,
          resolvedGenuine: true,
          offTargetFix: false,
          protocolFailure: false,
          lengthFailure: false,
          scopeTruncated: false,
          stopReason: "finished",
          editedCells: ["c1"],
          crf: 1.0,
          hitAt1: true,
          pqi: 1.0,
        },
      ];

      const incSummary = summarizeGroup(mockRuns, false);
      expect(incSummary.luckyPassRate).toBeNull();
      expect(incSummary.resolvedGenuine).toBe(1);
      expect(incSummary.amortizedTokensPerGenuineFix).toBe(200);

      mockRuns[0].luckyPass = false;
      const desSummary = summarizeGroup(mockRuns, true);
      expect(desSummary.luckyPassRate).toBe(0.0);
    });
  });
});
