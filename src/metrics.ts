/**
 * Pure Metrics Calculator for RewindBench (R7 Bagian 2)
 *
 * Implements pure evaluation functions over benchmark JSONL records:
 * - CRF (Causal Repair Fidelity / Cell Repair Fraction) = |editedCells ∩ {mutation.cellId}| / |editedCells|
 * - Hit@1 = editedCells[0] === mutation.cellId
 * - PQI (Process Quality Index / Path Quality Index) = direct_steps / total_steps
 * - resolvedGenuine = resolved && luckyPass !== true
 * - Token efficiency metrics (amortized tokens per genuine fix & avg tokens on genuine fixes)
 * - Paired discordant analysis (exact two-tailed binomial McNemar test across paired runs)
 *
 * Evaluates each corpus independently (Incidental Corpus and Designed Corpus).
 * Stratifies per distBand, per stratum, and per hopBand.
 * Outputs to results/metrics.json and stdout.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ArmResult } from "./arms/types";
import type { Stratum, HopBand, DistBand, Mutation } from "./mutate";

export interface RunMetric {
  arm: "monolithic" | "stepwise" | "rewind";
  mutationId: string;
  notebookId?: string;
  notebookName?: string;
  cellId: string;
  stratum: Stratum;
  distBand: DistBand;
  distanceToTerminal: number;
  hopBand: HopBand;
  hopDistance: number;
  model: string;

  turns: number;
  wallMs: number;
  promptTokens: number;
  reasoningTokens: number;
  answerTokens: number;
  totalTokens: number;

  resolved: boolean;
  luckyPass: boolean | null;
  resolvedGenuine: boolean;
  offTargetFix: boolean;
  protocolFailure: boolean;
  lengthFailure: boolean;
  scopeTruncated: boolean;
  stopReason: string;

  editedCells: string[];
  crf: number;
  hitAt1: boolean;
  pqi: number;
}

export interface SummaryGroupMetrics {
  totalRuns: number;
  validRuns: number;

  resolvedAll: number;
  resolvedAllPct: number;
  resolvedValid: number;
  resolvedValidPct: number;

  luckyPassCount: number;
  luckyPassRate: number | null; // null for incidental
  resolvedGenuine: number;
  resolvedGenuinePct: number;

  offTargetFixCount: number;
  protocolFailures: number;
  lengthFailures: number;

  crfMean: number;
  crfMedian: number;
  hitAt1Count: number;
  hitAt1Pct: number;
  pqiMean: number;
  pqiMedian: number;

  avgTurns: number;
  avgWallMs: number;

  avgPromptTokens: number;
  avgReasoningTokens: number;
  avgAnswerTokens: number;
  avgTotalTokens: number;

  totalPromptTokens: number;
  totalReasoningTokens: number;
  totalAnswerTokens: number;
  totalTokens: number;

  // Tokens per genuine fix
  amortizedTokensPerGenuineFix: number | null;
  avgTokensOnGenuineFixes: number | null;
}

export interface PairedComparison {
  arm1: string;
  arm2: string;
  totalMutations: number;
  bothResolved: number;
  arm1Won: number; // arm1 genuine-resolved, arm2 failed (b)
  arm2Won: number; // arm1 failed, arm2 genuine-resolved (c)
  bothFailed: number;
  totalDiscordant: number; // b + c
  exactBinomialPValue: number;
  discordantRatio: string;
}

export interface CorpusMetricsReport {
  corpusName: string;
  totalMutations: number;
  totalRuns: number;
  arms: {
    monolithic: SummaryGroupMetrics;
    stepwise: SummaryGroupMetrics;
    rewind: SummaryGroupMetrics;
  };
  byDistBand: Record<string, {
    monolithic?: SummaryGroupMetrics;
    stepwise?: SummaryGroupMetrics;
    rewind?: SummaryGroupMetrics;
    paired?: Record<string, PairedComparison>;
  }>;
  byStratum: Record<string, {
    monolithic?: SummaryGroupMetrics;
    stepwise?: SummaryGroupMetrics;
    rewind?: SummaryGroupMetrics;
    paired?: Record<string, PairedComparison>;
  }>;
  byHopBand: Record<string, {
    monolithic?: SummaryGroupMetrics;
    stepwise?: SummaryGroupMetrics;
    rewind?: SummaryGroupMetrics;
    paired?: Record<string, PairedComparison>;
  }>;
  pairedOverall: Record<string, PairedComparison>;
}

// --- PURE FORMULA IMPLEMENTATIONS ---

export function computeCRF(editedCells: string[], mutatedCellId: string): number {
  if (!editedCells || editedCells.length === 0) return 0;
  const targetMatches = editedCells.filter((c) => c === mutatedCellId).length;
  return targetMatches > 0 ? 1 / editedCells.length : 0;
}

export function computeHitAt1(editedCells: string[], mutatedCellId: string): boolean {
  if (!editedCells || editedCells.length === 0) return false;
  return editedCells[0] === mutatedCellId;
}

export function computePQI(
  transcriptPath: string | null,
  arm: string,
  turns: number,
  mutatedCellId: string,
  editedCells: string[]
): number {
  if (transcriptPath && existsSync(transcriptPath)) {
    try {
      const data = JSON.parse(readFileSync(transcriptPath, "utf8"));
      const messages: Array<{ role: string; content?: string }> = data.messages || [];
      const assistantMsgs = messages.filter((m) => m.role === "assistant" && m.content);

      if (assistantMsgs.length > 0) {
        let directSteps = 0;
        for (const msg of assistantMsgs) {
          const content = msg.content || "";
          const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
          if (jsonMatch) {
            try {
              const action = JSON.parse(jsonMatch[1]);
              if (action.action === "finish") {
                directSteps++;
              } else if (action.cell === mutatedCellId) {
                directSteps++;
              }
            } catch {
              // ignore parse errors
            }
          }
        }
        return assistantMsgs.length > 0 ? directSteps / assistantMsgs.length : 0;
      }
    } catch {
      // fallback
    }
  }

  // Fallback estimation if transcript is unavailable
  if (arm === "monolithic") {
    return 1.0;
  }
  if (editedCells.includes(mutatedCellId)) {
    return turns > 0 ? Math.min(1.0, 2.0 / turns) : 0;
  }
  return turns > 0 ? 1.0 / turns : 0;
}

/**
 * Exact Two-Tailed Binomial Test for McNemar's Paired Discordant Pairs
 */
export function exactBinomialPValue(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1.0;
  const k = Math.min(b, c);

  // Combination nCi
  function nCr(n: number, r: number): number {
    if (r < 0 || r > n) return 0;
    if (r === 0 || r === n) return 1;
    let res = 1;
    for (let i = 1; i <= r; i++) {
      res = (res * (n - i + 1)) / i;
    }
    return res;
  }

  let cumulativeP = 0;
  for (let i = 0; i <= k; i++) {
    cumulativeP += nCr(n, i) * Math.pow(0.5, n);
  }

  return Math.min(1.0, 2 * cumulativeP);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarizeGroup(runs: RunMetric[], isDesignedCorpus: boolean): SummaryGroupMetrics {
  const total = runs.length;
  if (total === 0) {
    return {
      totalRuns: 0,
      validRuns: 0,
      resolvedAll: 0,
      resolvedAllPct: 0,
      resolvedValid: 0,
      resolvedValidPct: 0,
      luckyPassCount: 0,
      luckyPassRate: null,
      resolvedGenuine: 0,
      resolvedGenuinePct: 0,
      offTargetFixCount: 0,
      protocolFailures: 0,
      lengthFailures: 0,
      crfMean: 0,
      crfMedian: 0,
      hitAt1Count: 0,
      hitAt1Pct: 0,
      pqiMean: 0,
      pqiMedian: 0,
      avgTurns: 0,
      avgWallMs: 0,
      avgPromptTokens: 0,
      avgReasoningTokens: 0,
      avgAnswerTokens: 0,
      avgTotalTokens: 0,
      totalPromptTokens: 0,
      totalReasoningTokens: 0,
      totalAnswerTokens: 0,
      totalTokens: 0,
      amortizedTokensPerGenuineFix: null,
      avgTokensOnGenuineFixes: null,
    };
  }

  const validRuns = runs.filter((r) => !r.protocolFailure && !r.lengthFailure);
  const validTotal = validRuns.length;

  const resolvedAll = runs.filter((r) => r.resolved).length;
  const resolvedValid = validRuns.filter((r) => r.resolved).length;

  const luckyCount = runs.filter((r) => r.luckyPass === true).length;
  const luckyRate = isDesignedCorpus ? (resolvedAll > 0 ? luckyCount / resolvedAll : 0) : null;

  const genuineResolvedRuns = runs.filter((r) => r.resolvedGenuine);
  const resolvedGenuineCount = genuineResolvedRuns.length;

  const offTargetCount = runs.filter((r) => r.offTargetFix).length;
  const protoFails = runs.filter((r) => r.protocolFailure).length;
  const lengthFails = runs.filter((r) => r.lengthFailure).length;

  const crfValues = runs.map((r) => r.crf);
  const hitAt1Count = runs.filter((r) => r.hitAt1).length;
  const pqiValues = runs.map((r) => r.pqi);

  const totalPrompt = runs.reduce((sum, r) => sum + r.promptTokens, 0);
  const totalReasoning = runs.reduce((sum, r) => sum + r.reasoningTokens, 0);
  const totalAnswer = runs.reduce((sum, r) => sum + r.answerTokens, 0);
  const totalToks = runs.reduce((sum, r) => sum + r.totalTokens, 0);

  const amortizedTokens = resolvedGenuineCount > 0 ? Math.round(totalToks / resolvedGenuineCount) : null;
  const avgTokensOnGenuine =
    resolvedGenuineCount > 0
      ? Math.round(genuineResolvedRuns.reduce((sum, r) => sum + r.totalTokens, 0) / resolvedGenuineCount)
      : null;

  return {
    totalRuns: total,
    validRuns: validTotal,
    resolvedAll,
    resolvedAllPct: (resolvedAll / total) * 100,
    resolvedValid,
    resolvedValidPct: validTotal > 0 ? (resolvedValid / validTotal) * 100 : 0,
    luckyPassCount: luckyCount,
    luckyPassRate: luckyRate !== null ? luckyRate * 100 : null,
    resolvedGenuine: resolvedGenuineCount,
    resolvedGenuinePct: (resolvedGenuineCount / total) * 100,
    offTargetFixCount: offTargetCount,
    protocolFailures: protoFails,
    lengthFailures: lengthFails,
    crfMean: mean(crfValues),
    crfMedian: median(crfValues),
    hitAt1Count,
    hitAt1Pct: (hitAt1Count / total) * 100,
    pqiMean: mean(pqiValues),
    pqiMedian: median(pqiValues),
    avgTurns: mean(runs.map((r) => r.turns)),
    avgWallMs: mean(runs.map((r) => r.wallMs)),
    avgPromptTokens: Math.round(totalPrompt / total),
    avgReasoningTokens: Math.round(totalReasoning / total),
    avgAnswerTokens: Math.round(totalAnswer / total),
    avgTotalTokens: Math.round(totalToks / total),
    totalPromptTokens: totalPrompt,
    totalReasoningTokens: totalReasoning,
    totalAnswerTokens: totalAnswer,
    totalTokens: totalToks,
    amortizedTokensPerGenuineFix: amortizedTokens,
    avgTokensOnGenuineFixes: avgTokensOnGenuine,
  };
}

export function computePairedComparison(
  runsArm1: RunMetric[],
  runsArm2: RunMetric[],
  arm1Name: string,
  arm2Name: string
): PairedComparison {
  const map1 = new Map<string, RunMetric>();
  const map2 = new Map<string, RunMetric>();

  for (const r of runsArm1) {
    const key = `${r.notebookId || r.notebookName || ""}:${r.mutationId}`;
    map1.set(key, r);
  }
  for (const r of runsArm2) {
    const key = `${r.notebookId || r.notebookName || ""}:${r.mutationId}`;
    map2.set(key, r);
  }

  const commonMutIds = Array.from(map1.keys()).filter((id) => map2.has(id));

  let bothResolved = 0;
  let arm1Won = 0; // arm1 genuine-resolved, arm2 failed (b)
  let arm2Won = 0; // arm1 failed, arm2 genuine-resolved (c)
  let bothFailed = 0;

  for (const mutId of commonMutIds) {
    const r1 = map1.get(mutId)!;
    const r2 = map2.get(mutId)!;

    const res1 = r1.resolvedGenuine;
    const res2 = r2.resolvedGenuine;

    if (res1 && res2) bothResolved++;
    else if (res1 && !res2) arm1Won++;
    else if (!res1 && res2) arm2Won++;
    else bothFailed++;
  }

  const totalDiscordant = arm1Won + arm2Won;
  const pValue = exactBinomialPValue(arm1Won, arm2Won);
  const ratioStr = `${arm1Won} : ${arm2Won}`;

  return {
    arm1: arm1Name,
    arm2: arm2Name,
    totalMutations: commonMutIds.length,
    bothResolved,
    arm1Won,
    arm2Won,
    bothFailed,
    totalDiscordant,
    exactBinomialPValue: pValue,
    discordantRatio: ratioStr,
  };
}

export function evaluateCorpus(
  corpusName: string,
  armsPath: string,
  mutationsPath: string,
  transcriptsDir: string,
  isDesignedCorpus: boolean
): CorpusMetricsReport | null {
  if (!existsSync(armsPath)) return null;

  const rawArmsLines = readFileSync(armsPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const armsData: ArmResult[] = rawArmsLines.map((l) => JSON.parse(l));

  // Load mutations for reference if exists
  const mutationMap = new Map<string, Mutation>();
  if (existsSync(mutationsPath)) {
    const rawMutLines = readFileSync(mutationsPath, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    for (const line of rawMutLines) {
      const m: Mutation = JSON.parse(line);
      mutationMap.set(m.id, m);
    }
  }

  // Convert to RunMetric with pure calculations
  const runMetrics: RunMetric[] = armsData.map((a) => {
    const mut = mutationMap.get(a.mutationId);
    const cellId = mut?.cellId || a.mutationId.split(":")[0];
    const safeId = a.mutationId.replace(/[:\/\\?*|<>"]/g, "_");
    const transcriptPath = join(transcriptsDir, `${a.arm}-${safeId}.json`);

    const crf = computeCRF(a.editedCells, cellId);
    const hitAt1 = computeHitAt1(a.editedCells, cellId);
    const pqi = computePQI(transcriptPath, a.arm, a.turns, cellId, a.editedCells);

    const luckyPass = a.luckyPass !== undefined ? a.luckyPass : (isDesignedCorpus ? false : null);
    const resolvedGenuine = a.resolved && luckyPass !== true;

    return {
      arm: a.arm,
      mutationId: a.mutationId,
      notebookId: mut?.notebookId,
      notebookName: mut?.notebookName,
      cellId,
      stratum: a.stratum,
      distBand: a.distBand,
      distanceToTerminal: a.distanceToTerminal ?? 0,
      hopBand: a.hopBand,
      hopDistance: a.hopDistance ?? 1,
      model: a.model,

      turns: a.turns,
      wallMs: a.wallMs,
      promptTokens: a.promptTokens,
      reasoningTokens: a.reasoningTokens,
      answerTokens: a.answerTokens,
      totalTokens: a.totalTokens,

      resolved: a.resolved,
      luckyPass,
      resolvedGenuine,
      offTargetFix: a.offTargetFix ?? false,
      protocolFailure: a.protocolFailure,
      lengthFailure: a.lengthFailure,
      scopeTruncated: a.scopeTruncated,
      stopReason: a.stopReason,

      editedCells: a.editedCells,
      crf,
      hitAt1,
      pqi,
    };
  });

  const monoRuns = runMetrics.filter((r) => r.arm === "monolithic");
  const stepRuns = runMetrics.filter((r) => r.arm === "stepwise");
  const rewindRuns = runMetrics.filter((r) => r.arm === "rewind");

  const overallMono = summarizeGroup(monoRuns, isDesignedCorpus);
  const overallStep = summarizeGroup(stepRuns, isDesignedCorpus);
  const overallRewind = summarizeGroup(rewindRuns, isDesignedCorpus);

  // Paired comparisons overall
  const pairedOverall: Record<string, PairedComparison> = {
    "rewind_vs_stepwise": computePairedComparison(rewindRuns, stepRuns, "rewind", "stepwise"),
    "stepwise_vs_monolithic": computePairedComparison(stepRuns, monoRuns, "stepwise", "monolithic"),
    "rewind_vs_monolithic": computePairedComparison(rewindRuns, monoRuns, "rewind", "monolithic"),
  };

  // Stratify by distBand
  const distBands: DistBand[] = ["direct", "short", "long", "unknown"];
  const byDistBand: Record<string, any> = {};

  for (const db of distBands) {
    const subsetMono = monoRuns.filter((r) => r.distBand === db);
    const subsetStep = stepRuns.filter((r) => r.distBand === db);
    const subsetRewind = rewindRuns.filter((r) => r.distBand === db);

    if (subsetMono.length === 0 && subsetStep.length === 0 && subsetRewind.length === 0) {
      continue;
    }

    byDistBand[db] = {
      monolithic: summarizeGroup(subsetMono, isDesignedCorpus),
      stepwise: summarizeGroup(subsetStep, isDesignedCorpus),
      rewind: summarizeGroup(subsetRewind, isDesignedCorpus),
      paired: {
        "rewind_vs_stepwise": computePairedComparison(subsetRewind, subsetStep, "rewind", "stepwise"),
        "stepwise_vs_monolithic": computePairedComparison(subsetStep, subsetMono, "stepwise", "monolithic"),
        "rewind_vs_monolithic": computePairedComparison(subsetRewind, subsetMono, "rewind", "monolithic"),
      },
    };
  }

  // Stratify by stratum
  const strata: Stratum[] = ["value-level", "name-level"];
  const byStratum: Record<string, any> = {};

  for (const st of strata) {
    const subsetMono = monoRuns.filter((r) => r.stratum === st);
    const subsetStep = stepRuns.filter((r) => r.stratum === st);
    const subsetRewind = rewindRuns.filter((r) => r.stratum === st);

    if (subsetMono.length === 0 && subsetStep.length === 0 && subsetRewind.length === 0) {
      continue;
    }

    byStratum[st] = {
      monolithic: summarizeGroup(subsetMono, isDesignedCorpus),
      stepwise: summarizeGroup(subsetStep, isDesignedCorpus),
      rewind: summarizeGroup(subsetRewind, isDesignedCorpus),
      paired: {
        "rewind_vs_stepwise": computePairedComparison(subsetRewind, subsetStep, "rewind", "stepwise"),
        "stepwise_vs_monolithic": computePairedComparison(subsetStep, subsetMono, "stepwise", "monolithic"),
        "rewind_vs_monolithic": computePairedComparison(subsetRewind, subsetMono, "rewind", "monolithic"),
      },
    };
  }

  // Stratify by hopBand
  const hopBands: HopBand[] = ["near", "mid", "far"];
  const byHopBand: Record<string, any> = {};

  for (const hb of hopBands) {
    const subsetMono = monoRuns.filter((r) => r.hopBand === hb);
    const subsetStep = stepRuns.filter((r) => r.hopBand === hb);
    const subsetRewind = rewindRuns.filter((r) => r.hopBand === hb);

    if (subsetMono.length === 0 && subsetStep.length === 0 && subsetRewind.length === 0) {
      continue;
    }

    byHopBand[hb] = {
      monolithic: summarizeGroup(subsetMono, isDesignedCorpus),
      stepwise: summarizeGroup(subsetStep, isDesignedCorpus),
      rewind: summarizeGroup(subsetRewind, isDesignedCorpus),
      paired: {
        "rewind_vs_stepwise": computePairedComparison(subsetRewind, subsetStep, "rewind", "stepwise"),
        "stepwise_vs_monolithic": computePairedComparison(subsetStep, subsetMono, "stepwise", "monolithic"),
        "rewind_vs_monolithic": computePairedComparison(subsetRewind, subsetMono, "rewind", "monolithic"),
      },
    };
  }

  const uniqueMutations = Array.from(
    new Set(runMetrics.map((r) => `${r.notebookId || r.notebookName || ""}:${r.mutationId}`))
  ).length;

  return {
    corpusName,
    totalMutations: uniqueMutations,
    totalRuns: runMetrics.length,
    arms: {
      monolithic: overallMono,
      stepwise: overallStep,
      rewind: overallRewind,
    },
    byDistBand,
    byStratum,
    byHopBand,
    pairedOverall,
  };
}

// --- FORMATTED STDOUT PRINTER ---

function pad(str: string | number, len: number, right = false): string {
  const s = String(str);
  return right ? s.padStart(len) : s.padEnd(len);
}

export function printCorpusReport(report: CorpusMetricsReport): void {
  console.log(`\n================================================================================`);
  console.log(`BENCHMARK METRICS REPORT: ${report.corpusName.toUpperCase()}`);
  console.log(`================================================================================`);
  console.log(`Total Ground-Truth Mutations: ${report.totalMutations} | Total Agent Runs: ${report.totalRuns}\n`);

  function printArmTable(title: string, mono?: SummaryGroupMetrics, step?: SummaryGroupMetrics, rewind?: SummaryGroupMetrics) {
    console.log(`--- ${title} ---`);
    console.log(
      `┌─────────────────────────────────┬───────────────┬───────────────┬───────────────┐\n` +
      `│ Metric                          │ Arm A (Mono)  │ Arm B (Step)  │ Arm C (Rewind)│\n` +
      `├─────────────────────────────────┼───────────────┼───────────────┼───────────────┤`
    );

    const rows = [
      ["Total Episodes (Runs)", mono?.totalRuns ?? "-", step?.totalRuns ?? "-", rewind?.totalRuns ?? "-"],
      ["Valid Protocol Episodes", mono?.validRuns ?? "-", step?.validRuns ?? "-", rewind?.validRuns ?? "-"],
      [
        "Resolved (All Runs)",
        mono ? `${mono.resolvedAll}/${mono.totalRuns} (${mono.resolvedAllPct.toFixed(1)}%)` : "-",
        step ? `${step.resolvedAll}/${step.totalRuns} (${step.resolvedAllPct.toFixed(1)}%)` : "-",
        rewind ? `${rewind.resolvedAll}/${rewind.totalRuns} (${rewind.resolvedAllPct.toFixed(1)}%)` : "-",
      ],
      [
        "Resolved (Valid Protocol)",
        mono ? `${mono.resolvedValid}/${mono.validRuns} (${mono.resolvedValidPct.toFixed(1)}%)` : "-",
        step ? `${step.resolvedValid}/${step.validRuns} (${step.resolvedValidPct.toFixed(1)}%)` : "-",
        rewind ? `${rewind.resolvedValid}/${rewind.validRuns} (${rewind.resolvedValidPct.toFixed(1)}%)` : "-",
      ],
      [
        "Lucky Passes (Held-Out)",
        mono ? (mono.luckyPassRate !== null ? `${mono.luckyPassCount} (${mono.luckyPassRate.toFixed(1)}%)` : "n/a") : "-",
        step ? (step.luckyPassRate !== null ? `${step.luckyPassCount} (${step.luckyPassRate.toFixed(1)}%)` : "n/a") : "-",
        rewind ? (rewind.luckyPassRate !== null ? `${rewind.luckyPassCount} (${rewind.luckyPassRate.toFixed(1)}%)` : "n/a") : "-",
      ],
      [
        "Resolved Genuine",
        mono ? `${mono.resolvedGenuine}/${mono.totalRuns} (${mono.resolvedGenuinePct.toFixed(1)}%)` : "-",
        step ? `${step.resolvedGenuine}/${step.totalRuns} (${step.resolvedGenuinePct.toFixed(1)}%)` : "-",
        rewind ? `${rewind.resolvedGenuine}/${rewind.totalRuns} (${rewind.resolvedGenuinePct.toFixed(1)}%)` : "-",
      ],
      ["Off-Target Fixes", mono?.offTargetFixCount ?? "-", step?.offTargetFixCount ?? "-", rewind?.offTargetFixCount ?? "-"],
      ["Protocol Failures", mono?.protocolFailures ?? "-", step?.protocolFailures ?? "-", rewind?.protocolFailures ?? "-"],
      ["Length Failures", mono?.lengthFailures ?? "-", step?.lengthFailures ?? "-", rewind?.lengthFailures ?? "-"],
      [
        "CRF (Mean / Median)",
        mono ? `${mono.crfMean.toFixed(3)} / ${mono.crfMedian.toFixed(3)}` : "-",
        step ? `${step.crfMean.toFixed(3)} / ${step.crfMedian.toFixed(3)}` : "-",
        rewind ? `${rewind.crfMean.toFixed(3)} / ${rewind.crfMedian.toFixed(3)}` : "-",
      ],
      [
        "Hit@1 Rate",
        mono ? `${mono.hitAt1Count}/${mono.totalRuns} (${mono.hitAt1Pct.toFixed(1)}%)` : "-",
        step ? `${step.hitAt1Count}/${step.totalRuns} (${step.hitAt1Pct.toFixed(1)}%)` : "-",
        rewind ? `${rewind.hitAt1Count}/${rewind.totalRuns} (${rewind.hitAt1Pct.toFixed(1)}%)` : "-",
      ],
      [
        "PQI (Mean / Median)",
        mono ? `${mono.pqiMean.toFixed(3)} / ${mono.pqiMedian.toFixed(3)}` : "-",
        step ? `${step.pqiMean.toFixed(3)} / ${step.pqiMedian.toFixed(3)}` : "-",
        rewind ? `${rewind.pqiMean.toFixed(3)} / ${rewind.pqiMedian.toFixed(3)}` : "-",
      ],
      [
        "Avg Turns / Wall-Clock",
        mono ? `${mono.avgTurns.toFixed(1)}t / ${(mono.avgWallMs / 1000).toFixed(1)}s` : "-",
        step ? `${step.avgTurns.toFixed(1)}t / ${(step.avgWallMs / 1000).toFixed(1)}s` : "-",
        rewind ? `${rewind.avgTurns.toFixed(1)}t / ${(rewind.avgWallMs / 1000).toFixed(1)}s` : "-",
      ],
      [
        "Avg Tokens (P/R/A/Total)",
        mono ? `${mono.avgPromptTokens}/${mono.avgReasoningTokens}/${mono.avgAnswerTokens}/${mono.avgTotalTokens}` : "-",
        step ? `${step.avgPromptTokens}/${step.avgReasoningTokens}/${step.avgAnswerTokens}/${step.avgTotalTokens}` : "-",
        rewind ? `${rewind.avgPromptTokens}/${rewind.avgReasoningTokens}/${rewind.avgAnswerTokens}/${rewind.avgTotalTokens}` : "-",
      ],
      [
        "Amortized Tok/Genuine Fix",
        mono?.amortizedTokensPerGenuineFix !== null ? `${mono?.amortizedTokensPerGenuineFix?.toLocaleString()}` : "n/a",
        step?.amortizedTokensPerGenuineFix !== null ? `${step?.amortizedTokensPerGenuineFix?.toLocaleString()}` : "n/a",
        rewind?.amortizedTokensPerGenuineFix !== null ? `${rewind?.amortizedTokensPerGenuineFix?.toLocaleString()}` : "n/a",
      ],
      [
        "Avg Tok/Genuine Fix (Wins)",
        mono?.avgTokensOnGenuineFixes !== null ? `${mono?.avgTokensOnGenuineFixes?.toLocaleString()}` : "n/a",
        step?.avgTokensOnGenuineFixes !== null ? `${step?.avgTokensOnGenuineFixes?.toLocaleString()}` : "n/a",
        rewind?.avgTokensOnGenuineFixes !== null ? `${rewind?.avgTokensOnGenuineFixes?.toLocaleString()}` : "n/a",
      ],
    ];

    for (const [m, a, b, c] of rows) {
      console.log(`│ ${pad(m, 31)} │ ${pad(a, 13)} │ ${pad(b, 13)} │ ${pad(c, 13)} │`);
    }
    console.log(`└─────────────────────────────────┴───────────────┴───────────────┴───────────────┘\n`);
  }

  function printPairedTable(title: string, paired?: Record<string, PairedComparison>) {
    if (!paired || Object.keys(paired).length === 0) return;
    console.log(`--- PAIRED DISCORDANT ANALYSIS (McNemar Exact Binomial Test): ${title} ---`);
    console.log(
      `┌──────────────────────────┬───────┬──────────────┬──────────────┬──────────────┬──────────────┬─────────────┬───────────┐\n` +
      `│ Comparison (X vs Y)      │ Pairs │ (+,+) BothOk │ (+,-) X Only │ (-,+) Y Only │ (-,-) BothFail│ Discord(b:c)│ Exact p   │\n` +
      `├──────────────────────────┼───────┼──────────────┼──────────────┼──────────────┼──────────────┼─────────────┼───────────┤`
    );
    for (const [key, p] of Object.entries(paired)) {
      const name = key.replace(/_/g, " ");
      console.log(
        `│ ${pad(name, 24)} │ ${pad(p.totalMutations, 5, true)} │ ${pad(p.bothResolved, 12, true)} │ ${pad(p.arm1Won, 12, true)} │ ${pad(p.arm2Won, 12, true)} │ ${pad(p.bothFailed, 12, true)} │ ${pad(p.discordantRatio, 11, true)} │ ${pad(p.exactBinomialPValue.toFixed(4), 9, true)} │`
      );
    }
    console.log(`└──────────────────────────┴───────┴──────────────┴──────────────┴──────────────┴──────────────┴─────────────┴───────────┘\n`);
  }

  // 1. Overall
  printArmTable("OVERALL SUMMARY", report.arms.monolithic, report.arms.stepwise, report.arms.rewind);
  printPairedTable("OVERALL", report.pairedOverall);

  // 2. Primary Axis: DistBand
  console.log(`################################################################################`);
  console.log(`PRIMARY DIFFICULTY AXIS: DISTANCE-TO-TERMINAL (distBand)`);
  console.log(`################################################################################\n`);
  for (const [db, data] of Object.entries(report.byDistBand)) {
    printArmTable(`DIST BAND: ${db.toUpperCase()}`, data.monolithic, data.stepwise, data.rewind);
    printPairedTable(`DIST BAND: ${db.toUpperCase()}`, data.paired);
  }

  // 3. Hypothesis Stratum: Value-level vs Name-level
  console.log(`################################################################################`);
  console.log(`HYPOTHESIS STRATIFICATION: VALUE-LEVEL (HYPOTHESIS) VS NAME-LEVEL (CONTROL)`);
  console.log(`################################################################################\n`);
  for (const [st, data] of Object.entries(report.byStratum)) {
    printArmTable(`STRATUM: ${st.toUpperCase()}`, data.monolithic, data.stepwise, data.rewind);
    printPairedTable(`STRATUM: ${st.toUpperCase()}`, data.paired);
  }

  // 4. Secondary Axis: HopBand
  console.log(`################################################################################`);
  console.log(`SECONDARY AXIS: DAG DEPTH (hopBand)`);
  console.log(`################################################################################\n`);
  for (const [hb, data] of Object.entries(report.byHopBand)) {
    printArmTable(`HOP BAND: ${hb.toUpperCase()}`, data.monolithic, data.stepwise, data.rewind);
    printPairedTable(`HOP BAND: ${hb.toUpperCase()}`, data.paired);
  }
}

export function main() {
  const resultsDir = process.env.RESULTS_DIR || "./results";
  const transcriptsDir = join(resultsDir, "transcripts");

  const incidentalReport = evaluateCorpus(
    "Incidental Corpus (Found Real Notebooks)",
    join(resultsDir, "arms.jsonl"),
    join(resultsDir, "mutations.jsonl"),
    transcriptsDir,
    false
  );

  const designedReport = evaluateCorpus(
    "Designed Heterogeneous Corpus (Reducing Terminals)",
    join(resultsDir, "arms-designed.jsonl"),
    join(resultsDir, "mutations-designed.jsonl"),
    transcriptsDir,
    true
  );

  let glmReport: CorpusMetricsReport | null = null;
  const glmPath = join(resultsDir, "arms-designed-glm.jsonl");
  if (existsSync(glmPath)) {
    const raw = readFileSync(glmPath, "utf8").trim();
    if (raw.length > 0) {
      glmReport = evaluateCorpus(
        "GLM-5.2 Cross-Model Evaluation (Designed Corpus)",
        glmPath,
        join(resultsDir, "mutations-designed.jsonl"),
        transcriptsDir,
        true
      );
    }
  }

  const allMetricsOutput: Record<string, any> = {};

  if (incidentalReport) {
    allMetricsOutput["incidental"] = incidentalReport;
    printCorpusReport(incidentalReport);
  }

  if (designedReport) {
    allMetricsOutput["designed"] = designedReport;
    printCorpusReport(designedReport);
  }

  if (glmReport) {
    allMetricsOutput["designed_glm"] = glmReport;
    printCorpusReport(glmReport);
  }

  const outPath = join(resultsDir, "metrics.json");
  writeFileSync(outPath, JSON.stringify(allMetricsOutput, null, 2), "utf8");
  console.log(`\nWrote complete metrics JSON to: ${outPath}\n`);
}

if (process.argv[1] && process.argv[1].includes("metrics")) {
  main();
}
