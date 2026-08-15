/**
 * CLI Runner for Arms A/B/C (R6 & R6.1 & R5.1 & R9 & R10)
 *
 * Runs Monolithic, Stepwise, and Rewind arms against ground truth mutations.
 * Supports incidental corpus (results/mutations.jsonl) and designed corpus (--designed, results/mutations-designed.jsonl).
 * Supplies terminal cell symptom (final expected vs actual output) and all cell sources upfront.
 * Enforces scratch notebook isolation (zz-rewind-arm-<uuid8>) and cleans them up in finally.
 * Saves transcripts to results/transcripts/<arm>-<mutationId>.json and appends records to results/arms.jsonl.
 * Reports summary stratified across hopBands (near, mid, far) and strata (overall, name-level, value-level).
 *
 * Usage:
 *   npm run arms -- --smoke --designed --hop=far   # 3 far-hop mutations from 3 distinct designed notebooks
 *   npm run arms -- --smoke --hop=far             # 3 far-hop mutations from incidental corpus
 *   npm run arms -- --smoke                       # 3 mutations × 3 arms
 *   npm run arms -- --limit=50                    # full benchmark run
 *   npm run arms -- --cleanup                     # remove any orphan zz-rewind-arm-*
 */

import { listNotebooks, getNotebook, runNotebook, requireEnv } from "./client";
import { runMonolithicArm } from "./arms/monolithic";
import { runStepwiseArm } from "./arms/stepwise";
import { runRewindArm } from "./arms/rewind";
import type { ArmResult, ArmContext } from "./arms/types";
import { stratumForKind, hopBandForDistance, type Mutation, type Stratum, type HopBand } from "./mutate";
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

function getBaseUrl(): string {
  const url = process.env.ZAA_BASE_URL?.trim() || "http://localhost:4000";
  return url.replace(/\/+$/, "");
}

function getAuthHeaders(): Record<string, string> {
  const token = requireEnv("ZAA_SESSION_TOKEN");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function apiRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      ...getAuthHeaders(),
      ...(options.headers as Record<string, string> | undefined),
    },
  });
  return res;
}

async function duplicateNotebook(notebookId: string): Promise<{ id: string; name: string }> {
  const res = await apiRequest(`/api/notebooks/${encodeURIComponent(notebookId)}/duplicate`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`Failed to duplicate notebook ${notebookId}: HTTP ${res.status}`);
  }
  return (await res.json()) as { id: string; name: string };
}

async function saveNotebookDoc(doc: any): Promise<any> {
  const res = await apiRequest(`/api/notebooks`, {
    method: "POST",
    body: JSON.stringify(doc),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to save notebook doc: HTTP ${res.status} ${text}`);
  }
  return await res.json();
}

async function deleteNotebook(notebookId: string, name?: string): Promise<void> {
  if (name && !name.startsWith("zz-rewind-arm-") && !name.endsWith("-copy")) {
    console.error(`Safety refusal: refusing to delete non-arm scratch notebook "${name}" (${notebookId})`);
    return;
  }
  const res = await apiRequest(`/api/notebooks/${encodeURIComponent(notebookId)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    console.error(`Failed to delete notebook ${notebookId}: HTTP ${res.status}`);
  }
}

async function pollRunFinished(
  notebookId: string,
  runId: string,
  pollIntervalMs = 200,
  timeoutMs = 60000
): Promise<any> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const res = await apiRequest(
      `/api/notebooks/${encodeURIComponent(notebookId)}/runs/${encodeURIComponent(runId)}`
    );
    if (res.ok) {
      const run = (await res.json()) as { status: string; cell_results?: Record<string, any>; error?: string };
      if (run.status !== "running") {
        if (!run.cell_results || Object.keys(run.cell_results).length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          const retryRes = await apiRequest(
            `/api/notebooks/${encodeURIComponent(notebookId)}/runs/${encodeURIComponent(runId)}`
          );
          if (retryRes.ok) return await retryRes.json();
        }
        return run;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Timeout polling run ${runId}`);
}

async function runScratchNotebookFull(scratchId: string): Promise<any> {
  const res = await apiRequest(`/api/notebooks/${encodeURIComponent(scratchId)}/run`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { status: "failed", error: `HTTP ${res.status}: ${text}` };
  }
  const { runId } = (await res.json()) as { runId: string };
  return await pollRunFinished(scratchId, runId);
}

async function runCellInScratch(
  scratchId: string,
  cellId: string,
  input?: Record<string, unknown>
): Promise<{ output?: unknown; error?: string }> {
  const res = await apiRequest(`/api/notebooks/${encodeURIComponent(scratchId)}/run`, {
    method: "POST",
    body: JSON.stringify({ cellId, input: input || {} }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { error: `HTTP ${res.status}: ${text}` };
  }
  const { runId } = (await res.json()) as { runId: string };
  const runDetail = await pollRunFinished(scratchId, runId);
  const cellResult = runDetail.cell_results?.[cellId];
  if (cellResult) {
    return {
      output: cellResult.output,
      error: cellResult.error,
    };
  }
  return {
    error: runDetail.error || "Cell result not found in run detail",
  };
}

function updateCellSourceInDoc(steps: any[], targetCellId: string, newSource: string): boolean {
  if (!Array.isArray(steps)) return false;
  for (const step of steps) {
    if (step.kind === "parallel" && Array.isArray(step.lanes)) {
      for (const lane of step.lanes) {
        if (updateCellSourceInDoc(lane.steps ?? [], targetCellId, newSource)) {
          return true;
        }
      }
      continue;
    }
    if (step.id === targetCellId) {
      step.code = newSource;
      return true;
    }
  }
  return false;
}

function getTerminalCellId(steps: any[]): string {
  let lastCellId = "";
  function walk(s?: any[]) {
    for (const step of s ?? []) {
      if (step.kind === "parallel") {
        for (const lane of step.lanes ?? []) walk(lane.steps);
        continue;
      }
      const code = step.code ?? "";
      if (code.trim().length > 0) {
        lastCellId = step.id;
      }
    }
  }
  walk(steps);
  return lastCellId;
}

function appendArmResult(path: string, result: ArmResult): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(result) + "\n", "utf8");
}

function saveTranscript(transcriptsDir: string, arm: string, mutation: Mutation, armResult: ArmResult, messages: any[]): void {
  mkdirSync(transcriptsDir, { recursive: true });
  const safeId = mutation.id.replace(/[:\/\\?*|<>"]/g, "_");
  const filePath = join(transcriptsDir, `${arm}-${safeId}.json`);
  const transcriptData = {
    arm: armResult.arm,
    mutationId: armResult.mutationId,
    stratum: armResult.stratum,
    hopDistance: armResult.hopDistance,
    hopBand: armResult.hopBand,
    notebookId: mutation.notebookId,
    notebookName: mutation.notebookName,
    model: armResult.model,
    turns: armResult.turns,
    stopReason: armResult.stopReason,
    resolved: armResult.resolved,
    luckyPass: armResult.luckyPass,
    editedCells: armResult.editedCells,
    wallMs: armResult.wallMs,
    tokens: {
      promptTokens: armResult.promptTokens,
      reasoningTokens: armResult.reasoningTokens,
      answerTokens: armResult.answerTokens,
      totalTokens: armResult.totalTokens,
    },
    messages,
  };
  writeFileSync(filePath, JSON.stringify(transcriptData, null, 2), "utf8");
}

function loadMutations(mutationsPath: string): Mutation[] {
  if (!existsSync(mutationsPath)) return [];
  const lines = readFileSync(mutationsPath, "utf8").trim().split("\n");
  const mutations: Mutation[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (!m.stratum) {
        m.stratum = stratumForKind(m.kind);
      }
      if (m.hopDistance === undefined) {
        m.hopDistance = 1;
      }
      if (!m.hopBand) {
        m.hopBand = hopBandForDistance(m.hopDistance);
      }
      mutations.push(m);
    } catch {
      // ignore
    }
  }
  return mutations;
}

async function runCleanup(): Promise<void> {
  console.log("Cleaning up all orphan zz-rewind-arm-* notebooks...");
  const notebooks = await listNotebooks();
  const scratchNbs = notebooks.filter(
    (nb) => nb.name.startsWith("zz-rewind-arm-") || nb.name.endsWith("-copy")
  );
  console.log(`Found ${scratchNbs.length} scratch notebook(s) to remove.`);
  for (const sn of scratchNbs) {
    await deleteNotebook(sn.id, sn.name);
    console.log(`  ✓ Deleted ${sn.name} (${sn.id})`);
  }
  console.log("Cleanup complete.\n");
}

function calculatePercentile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (percentile / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function printSummaryBlock(title: string, armRuns: ArmResult[], arms: string[]) {
  console.log(`\n--- ${title} ---`);
  for (const arm of arms) {
    const runs = armRuns.filter((r) => r.arm === arm);
    const total = runs.length;
    if (total === 0) {
      console.log(`  Arm ${arm.toUpperCase()}: no runs`);
      continue;
    }

    const resolved = runs.filter((r) => r.resolved).length;
    const lucky = runs.filter((r) => r.luckyPass).length;
    const protoFails = runs.filter((r) => r.protocolFailure).length;
    const lengthFails = runs.filter((r) => r.lengthFailure).length;
    const stopReasonCounts = runs.reduce((acc: Record<string, number>, r) => {
      acc[r.stopReason] = (acc[r.stopReason] || 0) + 1;
      return acc;
    }, {});
    const avgTurns = (runs.reduce((sum, r) => sum + r.turns, 0) / total).toFixed(1);
    const avgPrompt = Math.round(runs.reduce((sum, r) => sum + r.promptTokens, 0) / total);
    const avgReasoning = Math.round(runs.reduce((sum, r) => sum + r.reasoningTokens, 0) / total);
    const avgAnswer = Math.round(runs.reduce((sum, r) => sum + r.answerTokens, 0) / total);

    console.log(`  Arm: ${arm.toUpperCase()}`);
    console.log(`    Total runs:        ${total}`);
    console.log(`    Resolved:          ${resolved} / ${total} (${((resolved / total) * 100).toFixed(1)}%)`);
    console.log(`    Lucky passes:      ${lucky}`);
    console.log(`    Protocol failures: ${protoFails}`);
    console.log(`    Length failures:   ${lengthFails}`);
    console.log(`    Stop reasons:      ${JSON.stringify(stopReasonCounts)}`);
    console.log(`    Avg turns:         ${avgTurns}`);
    console.log(`    Avg tokens:        prompt=${avgPrompt}, reasoning=${avgReasoning}, ans=${avgAnswer}`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--cleanup")) {
    await runCleanup();
    return;
  }

  const isSmoke = args.includes("--smoke");
  const isDesigned = args.includes("--designed");
  let limit = isSmoke ? 3 : 50;
  let targetArm: "monolithic" | "stepwise" | "rewind" | null = null;
  let targetStratum: Stratum | null = null;
  let targetHop: HopBand | null = null;

  for (const arg of args) {
    if (arg.startsWith("--limit=")) {
      limit = parseInt(arg.split("=")[1], 10);
    }
    if (arg.startsWith("--arm=")) {
      targetArm = arg.split("=")[1] as "monolithic" | "stepwise" | "rewind";
    }
    if (arg.startsWith("--stratum=")) {
      targetStratum = arg.split("=")[1] as Stratum;
    }
    if (arg.startsWith("--hop=")) {
      targetHop = arg.split("=")[1] as HopBand;
    }
  }

  const resultsDir = process.env.RESULTS_DIR || "./results";
  const mutationsPath = isDesigned
    ? join(resultsDir, "mutations-designed.jsonl")
    : join(resultsDir, "mutations.jsonl");
  const armsPath = join(resultsDir, "arms.jsonl");
  const transcriptsDir = join(resultsDir, "transcripts");

  mkdirSync(resultsDir, { recursive: true });
  mkdirSync(transcriptsDir, { recursive: true });

  const mutations = loadMutations(mutationsPath);
  if (mutations.length === 0) {
    console.error(`No mutations found in ${mutationsPath}! Run "npm run mutate ${isDesigned ? "-- --designed" : ""}" first.`);
    process.exit(1);
  }

  let selectedMutations: Mutation[] = [];

  if (isSmoke) {
    // Filter candidates matching specified target criteria
    let candidates = mutations;
    if (targetHop) {
      candidates = candidates.filter((m) => m.hopBand === targetHop || (targetHop === "far" && m.hopDistance && m.hopDistance >= 7));
    }
    if (targetStratum) {
      candidates = candidates.filter((m) => m.stratum === targetStratum);
    }

    const seenNotebooks = new Set<string>();
    const seenCells = new Set<string>();

    for (const m of candidates) {
      if (!seenNotebooks.has(m.notebookId) && !seenCells.has(m.cellId)) {
        seenNotebooks.add(m.notebookId);
        seenCells.add(m.cellId);
        selectedMutations.push(m);
        if (selectedMutations.length >= 3) break;
      }
    }

    // Strict R10 requirement: must have 3 distinct notebooks, fail if insufficient
    if (selectedMutations.length < 3) {
      const distinctAvailable = new Set(candidates.map((c) => c.notebookId)).size;
      throw new Error(
        `Smoke run sampling failure: required 3 distinct notebooks for criteria (hop=${targetHop || "any"}, stratum=${targetStratum || "any"}), but only ${distinctAvailable} distinct notebook(s) are available in ${mutationsPath}.`
      );
    }
  } else {
    let filtered = mutations;
    if (targetHop) filtered = filtered.filter((m) => m.hopBand === targetHop);
    if (targetStratum) filtered = filtered.filter((m) => m.stratum === targetStratum);
    selectedMutations = filtered.slice(0, limit);
  }

  const armsToRun: Array<"monolithic" | "stepwise" | "rewind"> = targetArm
    ? [targetArm]
    : ["monolithic", "stepwise", "rewind"];

  const model = process.env.MODEL_PRIMARY || "deepseek-ai/DeepSeek-V4-Flash-0731";
  const maxTokens = parseInt(process.env.ARM_MAX_TOKENS || "8000", 10);
  const maxTurns = 15;

  console.log("=======================================================");
  console.log(
    isDesigned
      ? "R10 — ARMS (A/B/C) EVALUATION ON DESIGNED CORPUS"
      : "R9 — ARMS (A/B/C) EVALUATION BENCHMARK"
  );
  console.log("=======================================================");
  console.log(`Mode:            ${isSmoke ? "SMOKE RUN" : "FULL BENCHMARK"}`);
  console.log(`Corpus:          ${isDesigned ? "DESIGNED (results/mutations-designed.jsonl)" : "INCIDENTAL (results/mutations.jsonl)"}`);
  console.log(`Target mutants:  ${selectedMutations.length}`);
  if (targetHop) {
    console.log(`Target hop band: ${targetHop}`);
  }
  if (targetStratum) {
    console.log(`Target stratum:  ${targetStratum}`);
  }
  console.log(`Arms to run:     ${armsToRun.join(", ")}`);
  console.log(`Model:           ${model}`);
  console.log(`Max tokens:      ${maxTokens}`);
  console.log(`Max turns:       ${maxTurns}`);
  console.log(`Arms output:     ${armsPath}`);
  console.log(`Transcripts dir: ${transcriptsDir}\n`);

  const results: ArmResult[] = [];
  const completionTokensList: number[] = [];

  const notebookCache: Record<string, { originalDoc: any; baselineRun: any; terminalCellId: string }> = {};

  for (let mIdx = 0; mIdx < selectedMutations.length; mIdx++) {
    const mutation = selectedMutations[mIdx];
    const stratum = mutation.stratum || stratumForKind(mutation.kind);
    const hopDistance = mutation.hopDistance ?? 1;
    const hopBand = mutation.hopBand ?? hopBandForDistance(hopDistance);

    console.log(`\n[Mutation ${mIdx + 1}/${selectedMutations.length}] ${mutation.id} (${mutation.notebookName})`);
    console.log(`  Kind: ${mutation.kind} [${stratum}] | Hop: ${hopDistance} (${hopBand}) | Bug: ${mutation.description}`);

    if (!notebookCache[mutation.notebookId]) {
      try {
        const originalDoc: any = await getNotebook(mutation.notebookId);
        const baselineRun: any = await runNotebook(mutation.notebookId);
        if (baselineRun.status !== "success") {
          console.log(`  ⚠ Baseline run not successful (${baselineRun.status}), skipping mutation.`);
          continue;
        }
        const terminalCellId = getTerminalCellId(originalDoc.steps);
        notebookCache[mutation.notebookId] = { originalDoc, baselineRun, terminalCellId };
      } catch (nbErr) {
        console.log(`  ⚠ Failed to prepare notebook ${mutation.notebookName}: ${nbErr}`);
        continue;
      }
    }

    const { originalDoc, baselineRun, terminalCellId } = notebookCache[mutation.notebookId];

    for (const arm of armsToRun) {
      let scratchId: string | null = null;
      let scratchName = "";

      try {
        // 1. Duplicate notebook
        const dup = await duplicateNotebook(mutation.notebookId);
        scratchId = dup.id;
        const scratchDoc: any = await getNotebook(scratchId);
        const uuid8 = randomUUID().slice(0, 8);
        scratchName = `zz-rewind-arm-${uuid8}`;
        scratchDoc.name = scratchName;

        // 2. Inject mutated code into scratch notebook & save
        updateCellSourceInDoc(scratchDoc.steps, mutation.cellId, mutation.mutatedSource);
        await saveNotebookDoc(scratchDoc);

        // 3. Execute mutated notebook ONCE to obtain concrete symptom
        const actualRun = await runScratchNotebookFull(scratchId);

        // 4. Build arm context
        const ctx: ArmContext = {
          mutation,
          scratchNotebookDoc: scratchDoc,
          originalDoc,
          baselineRun,
          actualRun,
          terminalCellId,
          saveScratchDoc: async (doc: any) => {
            await saveNotebookDoc(doc);
          },
          runScratchCell: async (cellId: string, input?: Record<string, unknown>) => {
            return await runCellInScratch(scratchId!, cellId, input);
          },
          model,
          maxTokens,
          maxTurns,
        };

        // 5. Run arm
        let armExecutionResult: ArmResult & { messages: any[] };
        if (arm === "monolithic") {
          armExecutionResult = await runMonolithicArm(ctx);
        } else if (arm === "stepwise") {
          armExecutionResult = await runStepwiseArm(ctx);
        } else {
          armExecutionResult = await runRewindArm(ctx);
        }

        const { messages, ...armResult } = armExecutionResult;

        results.push(armResult);
        appendArmResult(armsPath, armResult);
        saveTranscript(transcriptsDir, arm, mutation, armResult, messages);

        const completionTokens = armResult.reasoningTokens + armResult.answerTokens;
        completionTokensList.push(completionTokens);

        const resIcon = armResult.resolved ? "✓ RESOLVED" : "✗ UNRESOLVED";
        const lucky = armResult.luckyPass ? " [LUCKY PASS]" : "";
        const protoFail = armResult.protocolFailure ? " [PROTOCOL FAIL]" : "";
        const lenFail = armResult.lengthFailure ? " [LENGTH FAIL]" : "";
        console.log(
          `  -> Arm ${arm.padEnd(10)}: ${resIcon}${lucky}${protoFail}${lenFail} [${armResult.stopReason}] | turns: ${armResult.turns} | tokens: prompt=${armResult.promptTokens}, reasoning=${armResult.reasoningTokens}, ans=${armResult.answerTokens} | ${armResult.wallMs}ms`
        );
      } catch (armErr) {
        console.log(`  -> Arm ${arm} failed with error: ${armErr}`);
      } finally {
        if (scratchId) {
          await deleteNotebook(scratchId, scratchName);
        }
      }
    }
  }

  // Summary Metrics
  console.log("\n" + "=".repeat(65));
  console.log(
    isDesigned
      ? "R10 BENCHMARK SUMMARY REPORT (Designed Heterogeneous Corpus)"
      : "R9 BENCHMARK SUMMARY REPORT"
  );
  console.log("=".repeat(65));

  printSummaryBlock("OVERALL RESULTS", results, armsToRun);

  // Breakdown by Hop Band
  console.log("\n" + "#".repeat(65));
  console.log("HOP BAND STRATIFICATION (Localization Difficulty)");
  console.log("#".repeat(65));
  printSummaryBlock("HOP BAND: NEAR (Hop 1-2)", results.filter((r) => r.hopBand === "near"), armsToRun);
  printSummaryBlock("HOP BAND: MID  (Hop 3-6)", results.filter((r) => r.hopBand === "mid"), armsToRun);
  printSummaryBlock("HOP BAND: FAR  (Hop 7+)",  results.filter((r) => r.hopBand === "far"), armsToRun);

  // Breakdown by Stratum
  console.log("\n" + "#".repeat(65));
  console.log("MUTATION STRATUM (Value-level vs Name-level)");
  console.log("#".repeat(65));
  printSummaryBlock("STRATUM: VALUE-LEVEL (Hypothesis)", results.filter((r) => r.stratum === "value-level"), armsToRun);
  printSummaryBlock("STRATUM: NAME-LEVEL (Control)", results.filter((r) => r.stratum === "name-level"), armsToRun);

  // Completion tokens distribution
  if (completionTokensList.length > 0) {
    const minTokens = Math.min(...completionTokensList);
    const maxTokensVal = Math.max(...completionTokensList);
    const medianTokens = Math.round(calculatePercentile(completionTokensList, 50));
    const p90Tokens = Math.round(calculatePercentile(completionTokensList, 90));

    console.log("\n" + "-".repeat(65));
    console.log("COMPLETION TOKENS DISTRIBUTION (Reasoning + Answer):");
    console.log(`  Min:    ${minTokens} tokens`);
    console.log(`  Median: ${medianTokens} tokens`);
    console.log(`  P90:    ${p90Tokens} tokens`);
    console.log(`  Max:    ${maxTokensVal} tokens`);
    console.log("-".repeat(65));
  }
  console.log("=".repeat(65));
}

main().catch((err) => {
  console.error("Arms run failed:", err);
  process.exit(1);
});
