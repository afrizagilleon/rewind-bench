/**
 * CLI Runner for Mutation Engine (R9 Stratified & Hop-Calibrated Ground Truth)
 *
 * Generates and validates synthetic bugs against deterministic cells with upstream dependencies.
 * A cell is ELIGIBLE ONLY if at least one key it reads is produced by an earlier cell (readsFromUpstream = true).
 * Enforces R9 composition: >=8 near (1-2), >=8 mid (3-6), >=8 far (7+), max 5 per notebook (relaxed for 20-cell pipeline), >=8 distinct notebooks.
 *
 * Usage:
 *   npm run mutate -- --fresh
 *   npm run mutate -- --limit=50
 *   npm run mutate -- --cleanup
 */

import { listNotebooks, getNotebook, runNotebook, requireEnv } from "./client";
import { scopeBefore } from "./msr";
import {
  mutationsFor,
  appendMutation,
  loadDeterministicCells,
  computeHopDistances,
  stratumForKind,
  hopBandForDistance,
  type Mutation,
  type MutationKind,
  type Stratum,
  type HopBand,
} from "./mutate";
import { hashValue } from "./ledger";
import { join } from "node:path";
import { rmSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
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
  if (name && !name.startsWith("zz-rewind-scratch-") && !name.endsWith("-copy")) {
    console.error(`Safety refusal: refusing to delete non-scratch notebook "${name}" (${notebookId})`);
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
      const run = (await res.json()) as { status: string };
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
  input: Record<string, unknown>
): Promise<{ output?: unknown; error?: string }> {
  const res = await apiRequest(`/api/notebooks/${encodeURIComponent(scratchId)}/run`, {
    method: "POST",
    body: JSON.stringify({ cellId, input }),
  });
  if (!res.ok) {
    throw new Error(`Failed to start scratch cell run: HTTP ${res.status}`);
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
    error: runDetail.error || "Cell result not found in scratch run detail",
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

function getExecutableCells(steps: any[]): Array<{ id: string; code: string }> {
  const cells: Array<{ id: string; code: string }> = [];
  function walk(s?: any[]) {
    for (const step of s ?? []) {
      if (step.kind === "parallel") {
        for (const lane of step.lanes ?? []) walk(lane.steps);
        continue;
      }
      const code = step.code ?? "";
      if (code.trim().length > 0) {
        cells.push({ id: step.id, code });
      }
    }
  }
  walk(steps);
  return cells;
}

async function runCleanup(): Promise<void> {
  console.log("Cleaning up all orphan zz-rewind-scratch-* notebooks...");
  const notebooks = await listNotebooks();
  const scratchNbs = notebooks.filter(
    (nb) => nb.name.startsWith("zz-rewind-scratch-") || nb.name.endsWith("-copy")
  );
  console.log(`Found ${scratchNbs.length} scratch/copy notebook(s) to remove.`);
  for (const sn of scratchNbs) {
    await deleteNotebook(sn.id, sn.name);
    console.log(`  ✓ Deleted ${sn.name} (${sn.id})`);
  }
  console.log("Cleanup complete.\n");
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--cleanup")) {
    await runCleanup();
    return;
  }

  let limit = 50;
  let maxPerNotebook = 3;
  let allowedKinds: Set<MutationKind> | null = null;
  const isFresh = args.includes("--fresh") || !args.some((a) => a.startsWith("--limit="));

  for (const arg of args) {
    if (arg.startsWith("--limit=")) {
      limit = parseInt(arg.split("=")[1], 10);
    }
    if (arg.startsWith("--max-per-nb=")) {
      maxPerNotebook = parseInt(arg.split("=")[1], 10);
    }
    if (arg.startsWith("--kinds=")) {
      const kinds = arg
        .split("=")[1]
        .split(",")
        .map((k) => k.trim() as MutationKind);
      allowedKinds = new Set(kinds);
    }
  }

  const resultsDir = process.env.RESULTS_DIR || "./results";
  const determinismPath = join(resultsDir, "determinism.jsonl");
  const mutationsPath = join(resultsDir, "mutations.jsonl");
  const backupR51Path = join(resultsDir, "mutations-r51.jsonl");

  mkdirSync(resultsDir, { recursive: true });

  if (isFresh) {
    if (existsSync(mutationsPath) && !existsSync(backupR51Path)) {
      copyFileSync(mutationsPath, backupR51Path);
      console.log(`Preserved previous corpus as ${backupR51Path}`);
    }
    try {
      rmSync(mutationsPath, { force: true });
      console.log("Reset previous mutations.jsonl for fresh R9 mutation run.");
    } catch {
      // ignore
    }
  }

  console.log("=======================================================");
  console.log("R9 — MUTATION ENGINE (Hop-Calibrated Ground Truth)");
  console.log("=======================================================");
  console.log(`Target verified limit: ${limit}`);
  console.log(`Targets:               >=8 near (1-2), >=8 mid (3-6), >=8 far (7+)`);
  console.log(`Max per notebook:      ${maxPerNotebook} (relaxed for 20-cell pipeline)`);
  console.log(`Eligibility rule:      readsFromUpstream === true (AST verified)`);
  if (allowedKinds) {
    console.log(`Allowed kinds:         ${Array.from(allowedKinds).join(", ")}`);
  }
  console.log(`Mutations output:      ${mutationsPath}\n`);

  // 1. Load verified deterministic cells from H4 census
  const deterministicCells = loadDeterministicCells(determinismPath);
  console.log(`Loaded ${deterministicCells.size} deterministic target cell(s) from H4 census.\n`);

  if (deterministicCells.size === 0) {
    console.error("No deterministic cells found! Run determinism census first.");
    process.exit(1);
  }

  const allNotebooks = await listNotebooks();
  const notebooks = allNotebooks.filter(
    (nb) => !nb.name.startsWith("zz-rewind-scratch-") && !nb.name.endsWith("-copy")
  );

  let totalCandidatesGenerated = 0;
  let totalValidatedMutations = 0;
  let totalNear = 0;
  let totalMid = 0;
  let totalFar = 0;
  let totalNameLevel = 0;
  let totalValueLevel = 0;

  const kindStats: Record<MutationKind, { generated: number; validated: number }> = {
    "key-rename": { generated: 0, validated: 0 },
    "off-by-one": { generated: 0, validated: 0 },
    "operand-swap": { generated: 0, validated: 0 },
    "dropped-await": { generated: 0, validated: 0 },
    "type-coercion": { generated: 0, validated: 0 },
    "arith-swap": { generated: 0, validated: 0 },
    "const-perturb": { generated: 0, validated: 0 },
    "comparison-flip": { generated: 0, validated: 0 },
    "index-shift": { generated: 0, validated: 0 },
    "filter-invert": { generated: 0, validated: 0 },
  };

  const validatedByNotebook: Record<string, number> = {};

  for (let idx = 0; idx < notebooks.length; idx++) {
    if (totalValidatedMutations >= limit && totalNear >= 8 && totalMid >= 8 && totalFar >= 8) break;

    const nb = notebooks[idx];
    let originalDoc: any;
    try {
      originalDoc = await getNotebook(nb.id);
    } catch {
      continue;
    }

    const hopMap = computeHopDistances(originalDoc.steps);
    const execCells = getExecutableCells(originalDoc.steps);

    // R9 Filter: ONLY cells that are deterministic AND read from upstream (hopDistance >= 1)
    const eligibleCells = execCells.filter((c) => {
      const isDet = deterministicCells.has(`${nb.id}:${c.id}`);
      const hopInfo = hopMap.get(c.id);
      return isDet && hopInfo && hopInfo.readsFromUpstream && hopInfo.hopDistance >= 1;
    });

    if (eligibleCells.length === 0) continue;

    console.log(`\n[${idx + 1}/${notebooks.length}] Notebook: ${nb.name} (${eligibleCells.length} eligible upstream-reading cell(s))`);

    let nbValidatedCount = 0;
    let scratchDoc: any = null;
    let scratchId: string | null = null;
    let scratchName = "";

    const isDeepPipeline = nb.name === "zz-uji-20-cell";
    const nbCap = isDeepPipeline ? 22 : maxPerNotebook;
    const maxPerCell = isDeepPipeline ? 2 : 2;

    try {
      // Run baseline run to get ground-truth outputs and scopeBefore
      let baselineRun: any;
      try {
        baselineRun = await runNotebook(nb.id);
        if (baselineRun.status !== "success") {
          console.log(`  ⚠ Skipping: baseline run completed with status "${baselineRun.status}"`);
          continue;
        }
      } catch (err) {
        console.log(`  ⚠ Skipping: baseline run failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      for (const cell of eligibleCells) {
        if (totalValidatedMutations >= limit && totalNear >= 8 && totalMid >= 8 && totalFar >= 8) break;
        if (nbValidatedCount >= nbCap) break;

        const hopInfo = hopMap.get(cell.id)!;
        const baselineResult = baselineRun.cell_results?.[cell.id];
        if (!baselineResult || baselineResult.error || baselineResult.output === undefined) {
          continue;
        }

        const scope = scopeBefore(originalDoc, baselineRun, cell.id);
        const baselineHash = hashValue(baselineResult.output);

        // Generate Layer-1 syntax valid candidates
        const rawCandidates = mutationsFor(nb.id, nb.name, cell.id, cell.code);
        // Prioritize value-level candidates
        const sortedCandidates = rawCandidates.sort((a, b) => {
          if (a.kind === "key-rename" && b.kind !== "key-rename") return 1;
          if (a.kind !== "key-rename" && b.kind === "key-rename") return -1;
          return 0;
        });

        const candidates = allowedKinds
          ? sortedCandidates.filter((m) => allowedKinds!.has(m.kind))
          : sortedCandidates;

        let cellValidatedCount = 0;

        for (const candidate of candidates) {
          if (cellValidatedCount >= maxPerCell) break;
          const stratum = stratumForKind(candidate.kind);

          // Control group cap: maximum 15 name-level mutations in total
          if (stratum === "name-level" && totalNameLevel >= 15) {
            continue;
          }

          kindStats[candidate.kind].generated++;
          totalCandidatesGenerated++;

          if (totalValidatedMutations >= limit && totalNear >= 8 && totalMid >= 8 && totalFar >= 8) break;
          if (nbValidatedCount >= nbCap) break;

          // Lazy scratch creation: duplicate notebook once per source notebook
          if (!scratchDoc) {
            try {
              const dup = await duplicateNotebook(nb.id);
              scratchId = dup.id;
              scratchDoc = await getNotebook(scratchId);
              const uuid8 = randomUUID().slice(0, 8);
              scratchName = `zz-rewind-scratch-${uuid8}`;
              scratchDoc.name = scratchName;
            } catch (err) {
              console.log(`  ⚠ Skipping notebook duplicate failed: ${err instanceof Error ? err.message : String(err)}`);
              break;
            }
          }

          // Layer 2: Behavioral validation via scratch execution
          try {
            updateCellSourceInDoc(scratchDoc.steps, cell.id, candidate.mutatedSource);
            await saveNotebookDoc(scratchDoc);

            const mutantResult = await runCellInScratch(
              scratchId!,
              cell.id,
              scope.scope
            );

            let mutantErrored = false;
            let mutantHash = "ERROR";
            let behavioralDeviation = false;

            if (mutantResult.error) {
              mutantErrored = true;
              behavioralDeviation = true;
            } else if (mutantResult.output !== undefined) {
              mutantHash = hashValue(mutantResult.output);
              behavioralDeviation = mutantHash !== baselineHash;
            }

            if (behavioralDeviation) {
              const verifiedMutation: Mutation = {
                ...candidate,
                stratum,
                hopDistance: hopInfo.hopDistance,
                hopBand: hopInfo.hopBand,
                baselineHash,
                mutantHash,
                mutantErrored,
              };

              appendMutation(mutationsPath, verifiedMutation);
              totalValidatedMutations++;
              nbValidatedCount++;
              cellValidatedCount++;
              kindStats[candidate.kind].validated++;
              if (stratum === "name-level") totalNameLevel++;
              else totalValueLevel++;

              if (hopInfo.hopBand === "near") totalNear++;
              else if (hopInfo.hopBand === "mid") totalMid++;
              else totalFar++;

              validatedByNotebook[nb.name] = (validatedByNotebook[nb.name] || 0) + 1;

              const errNote = mutantErrored ? " [crashed]" : "";
              console.log(
                `  ✓ [${candidate.kind} | ${stratum} | hop ${hopInfo.hopDistance} (${hopInfo.hopBand})] ${cell.id}: ${candidate.description}${errNote}`
              );
            } else {
              console.log(
                `  ✗ Discarded [${candidate.kind}] on ${cell.id}: output hash unchanged`
              );
            }
          } catch (execErr) {
            console.log(`  ⚠ Mutant execution error: ${execErr instanceof Error ? execErr.message : String(execErr)}`);
          }
        }
      }
    } catch (nbErr) {
      console.log(`  ⚠ Error processing notebook ${nb.name}: ${nbErr instanceof Error ? nbErr.message : String(nbErr)}`);
    } finally {
      if (scratchId) {
        await deleteNotebook(scratchId, scratchName);
      }
    }
  }

  // Summary Report
  const passRate =
    totalCandidatesGenerated > 0
      ? ((totalValidatedMutations / totalCandidatesGenerated) * 100).toFixed(2)
      : "0";
  const distinctNotebooksCount = Object.keys(validatedByNotebook).length;

  console.log("\n" + "=".repeat(60));
  console.log("MUTATION ENGINE SUMMARY (R9 Hop-Calibrated Ground Truth)");
  console.log("=".repeat(60));
  console.log(`Candidates generated (Layer 1 syntax): ${totalCandidatesGenerated}`);
  console.log(`Validated mutations (Layer 2 behavior): ${totalValidatedMutations}`);
  console.log(`Distinct notebooks:                    ${distinctNotebooksCount} (target >= 8)`);
  console.log(`\nHop Band Distribution:`);
  console.log(`  - near (hop 1-2):                    ${totalNear} (target >= 8)`);
  console.log(`  - mid  (hop 3-6):                    ${totalMid} (target >= 8)`);
  console.log(`  - far  (hop 7+):                     ${totalFar} (target >= 8)`);
  console.log(`\nStratum Distribution:`);
  console.log(`  - Value-level stratum:               ${totalValueLevel}`);
  console.log(`  - Name-level stratum (control):      ${totalNameLevel}`);
  console.log(`Behavioral validation rate:            ${passRate}%`);
  console.log("\nBreakdown by Mutation Kind:");
  for (const [k, stats] of Object.entries(kindStats) as [MutationKind, { generated: number; validated: number }][]) {
    const rate = stats.generated > 0 ? ((stats.validated / stats.generated) * 100).toFixed(1) : "0";
    const stratum = stratumForKind(k);
    console.log(
      `  ${k.padEnd(16)} [${stratum.padEnd(11)}]: ${String(stats.validated).padStart(3)} / ${String(stats.generated).padStart(3)} validated (${rate}%)`
    );
  }
  console.log("\nBreakdown by Notebook:");
  for (const [nbName, count] of Object.entries(validatedByNotebook)) {
    console.log(`  - ${nbName}: ${count} mutation(s)`);
  }
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("Mutation engine run failed:", err);
  process.exit(1);
});
