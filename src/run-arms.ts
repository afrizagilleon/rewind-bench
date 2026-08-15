/**
 * CLI Runner for Arms A/B/C (R6)
 *
 * Runs Monolithic, Stepwise, and Rewind arms against ground truth mutations.
 * Enforces scratch notebook isolation (zz-rewind-arm-<uuid8>) and cleans them up in finally.
 * Appends results to results/arms.jsonl per record.
 *
 * Usage:
 *   npm run arms -- --smoke                  # 3 mutations × 3 arms
 *   npm run arms -- --limit=50               # full benchmark run
 *   npm run arms -- --arm=rewind --limit=10  # single arm
 *   npm run arms -- --cleanup                # remove any orphan zz-rewind-arm-*
 */

import { listNotebooks, getNotebook, runNotebook, requireEnv } from "./client";
import { runMonolithicArm } from "./arms/monolithic";
import { runStepwiseArm } from "./arms/stepwise";
import { runRewindArm } from "./arms/rewind";
import type { ArmResult, ArmContext } from "./arms/types";
import type { Mutation } from "./mutate";
import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
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
        return run;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Timeout polling run ${runId}`);
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

function appendArmResult(path: string, result: ArmResult): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(result) + "\n", "utf8");
}

function loadMutations(mutationsPath: string): Mutation[] {
  if (!existsSync(mutationsPath)) return [];
  const lines = readFileSync(mutationsPath, "utf8").trim().split("\n");
  const mutations: Mutation[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      mutations.push(JSON.parse(line));
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

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--cleanup")) {
    await runCleanup();
    return;
  }

  const isSmoke = args.includes("--smoke");
  let limit = isSmoke ? 3 : 50;
  let targetArm: "monolithic" | "stepwise" | "rewind" | null = null;

  for (const arg of args) {
    if (arg.startsWith("--limit=")) {
      limit = parseInt(arg.split("=")[1], 10);
    }
    if (arg.startsWith("--arm=")) {
      targetArm = arg.split("=")[1] as "monolithic" | "stepwise" | "rewind";
    }
  }

  const resultsDir = process.env.RESULTS_DIR || "./results";
  const mutationsPath = join(resultsDir, "mutations.jsonl");
  const armsPath = join(resultsDir, "arms.jsonl");

  mkdirSync(resultsDir, { recursive: true });

  const mutations = loadMutations(mutationsPath);
  if (mutations.length === 0) {
    console.error(`No mutations found in ${mutationsPath}! Run "npm run mutate" first.`);
    process.exit(1);
  }

  const targetMutations = mutations.slice(0, limit);
  const armsToRun: Array<"monolithic" | "stepwise" | "rewind"> = targetArm
    ? [targetArm]
    : ["monolithic", "stepwise", "rewind"];

  const model = process.env.MODEL_PRIMARY || "deepseek-ai/DeepSeek-V4-Flash-0731";
  const maxTokens = parseInt(process.env.ARM_MAX_TOKENS || "8000", 10);

  console.log("=======================================================");
  console.log("R6 — ARMS (A/B/C) EVALUATION BENCHMARK");
  console.log("=======================================================");
  console.log(`Mode:            ${isSmoke ? "SMOKE RUN (3 mutations × 3 arms)" : "FULL BENCHMARK"}`);
  console.log(`Target mutants:  ${targetMutations.length}`);
  console.log(`Arms to run:     ${armsToRun.join(", ")}`);
  console.log(`Model:           ${model}`);
  console.log(`Max tokens:      ${maxTokens}`);
  console.log(`Arms output:     ${armsPath}\n`);

  const results: ArmResult[] = [];
  const completionTokensList: number[] = [];

  // Cache baseline runs and documents to avoid refetching
  const notebookCache: Record<string, { originalDoc: any; baselineRun: any }> = {};

  for (let mIdx = 0; mIdx < targetMutations.length; mIdx++) {
    const mutation = targetMutations[mIdx];
    console.log(`\n[Mutation ${mIdx + 1}/${targetMutations.length}] ${mutation.id} (${mutation.notebookName})`);
    console.log(`  Kind: ${mutation.kind} | Bug: ${mutation.description}`);

    // Load or cache baseline run
    if (!notebookCache[mutation.notebookId]) {
      try {
        const originalDoc = await getNotebook(mutation.notebookId);
        const baselineRun = await runNotebook(mutation.notebookId);
        if (baselineRun.status !== "success") {
          console.log(`  ⚠ Baseline run not successful (${baselineRun.status}), skipping mutation.`);
          continue;
        }
        notebookCache[mutation.notebookId] = { originalDoc, baselineRun };
      } catch (nbErr) {
        console.log(`  ⚠ Failed to prepare notebook ${mutation.notebookName}: ${nbErr}`);
        continue;
      }
    }

    const { originalDoc, baselineRun } = notebookCache[mutation.notebookId];

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

        // 2. Inject mutated code into scratch notebook
        updateCellSourceInDoc(scratchDoc.steps, mutation.cellId, mutation.mutatedSource);
        await saveNotebookDoc(scratchDoc);

        // 3. Build arm context
        const ctx: ArmContext = {
          mutation,
          scratchNotebookDoc: scratchDoc,
          originalDoc,
          baselineRun,
          saveScratchDoc: async (doc: any) => {
            await saveNotebookDoc(doc);
          },
          runScratchCell: async (cellId: string, input?: Record<string, unknown>) => {
            return await runCellInScratch(scratchId!, cellId, input);
          },
          model,
          maxTokens,
        };

        // 4. Run arm
        let armResult: ArmResult;
        if (arm === "monolithic") {
          armResult = await runMonolithicArm(ctx);
        } else if (arm === "stepwise") {
          armResult = await runStepwiseArm(ctx);
        } else {
          armResult = await runRewindArm(ctx);
        }

        results.push(armResult);
        appendArmResult(armsPath, armResult);

        const completionTokens = armResult.reasoningTokens + armResult.answerTokens;
        completionTokensList.push(completionTokens);

        const resIcon = armResult.resolved ? "✓ RESOLVED" : "✗ UNRESOLVED";
        const lucky = armResult.luckyPass ? " [LUCKY PASS]" : "";
        const protoFail = armResult.protocolFailure ? " [PROTOCOL FAIL]" : "";
        const lenFail = armResult.lengthFailure ? " [LENGTH FAIL]" : "";
        console.log(
          `  -> Arm ${arm.padEnd(10)}: ${resIcon}${lucky}${protoFail}${lenFail} | turns: ${armResult.turns} | tokens: prompt=${armResult.promptTokens}, reasoning=${armResult.reasoningTokens}, ans=${armResult.answerTokens} | ${armResult.wallMs}ms`
        );
      } catch (armErr) {
        console.log(`  -> Arm ${arm} failed with error: ${armErr}`);
      } finally {
        // 5. Clean up scratch notebook
        if (scratchId) {
          await deleteNotebook(scratchId, scratchName);
        }
      }
    }
  }

  // Summary Metrics
  console.log("\n" + "=".repeat(65));
  console.log("R6 BENCHMARK SUMMARY");
  console.log("=".repeat(65));

  for (const arm of armsToRun) {
    const armRuns = results.filter((r) => r.arm === arm);
    const total = armRuns.length;
    if (total === 0) continue;

    const resolved = armRuns.filter((r) => r.resolved).length;
    const lucky = armRuns.filter((r) => r.luckyPass).length;
    const protoFails = armRuns.filter((r) => r.protocolFailure).length;
    const lengthFails = armRuns.filter((r) => r.lengthFailure).length;
    const avgTurns = (armRuns.reduce((sum, r) => sum + r.turns, 0) / total).toFixed(1);
    const avgPrompt = Math.round(armRuns.reduce((sum, r) => sum + r.promptTokens, 0) / total);
    const avgReasoning = Math.round(armRuns.reduce((sum, r) => sum + r.reasoningTokens, 0) / total);
    const avgAnswer = Math.round(armRuns.reduce((sum, r) => sum + r.answerTokens, 0) / total);

    console.log(`\nArm: ${arm.toUpperCase()}`);
    console.log(`  Total runs:        ${total}`);
    console.log(`  Resolved:          ${resolved} / ${total} (${((resolved / total) * 100).toFixed(1)}%)`);
    console.log(`  Lucky passes:      ${lucky}`);
    console.log(`  Protocol failures: ${protoFails}`);
    console.log(`  Length failures:   ${lengthFails}`);
    console.log(`  Avg turns:         ${avgTurns}`);
    console.log(`  Avg tokens:        prompt=${avgPrompt}, reasoning=${avgReasoning}, ans=${avgAnswer}`);
  }

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
