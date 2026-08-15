/**
 * CLI Runner for Determinism Census (R4 / R4.1)
 *
 * Usage:
 *   npx tsx src/run-census.ts --smoke
 *   npx tsx src/run-census.ts --replays=3 --limit=3
 *   npx tsx src/run-census.ts --replays=10 --fresh
 */

import { listNotebooks } from "./client";
import { censusNotebook, type CellVerdict, type DeterminismCause } from "./determinism";
import { join } from "node:path";
import { rmSync, mkdirSync } from "node:fs";

async function main() {
  const args = process.argv.slice(2);
  const isSmoke = args.includes("--smoke");
  const isFresh = args.includes("--fresh") || (!isSmoke && !args.some((a) => a.startsWith("--notebook")));

  let replays = isSmoke ? 3 : 10;
  let limit = isSmoke ? 3 : 0;
  let targetNotebook: string | null = null;

  for (const arg of args) {
    if (arg.startsWith("--replays=")) {
      replays = parseInt(arg.split("=")[1], 10);
    }
    if (arg.startsWith("--limit=")) {
      limit = parseInt(arg.split("=")[1], 10);
    }
    if (arg.startsWith("--notebook=")) {
      targetNotebook = arg.split("=")[1];
    }
  }

  const resultsDir = process.env.RESULTS_DIR || "./results";
  const ledgerPath = join(resultsDir, "ledger.jsonl");
  const resultsPath = join(resultsDir, "determinism.jsonl");

  mkdirSync(resultsDir, { recursive: true });

  if (isFresh) {
    try {
      rmSync(ledgerPath, { force: true });
      rmSync(resultsPath, { force: true });
      console.log("Cleared previous ledger and verdict results for fresh census run.");
    } catch {
      // ignore
    }
  }

  console.log(`Starting Determinism Census (replays=${replays}, limit=${limit || "all"})...`);
  console.log(`Ledger: ${ledgerPath}`);
  console.log(`Verdicts: ${resultsPath}\n`);

  const notebooks = await listNotebooks();
  let selected = notebooks;

  if (targetNotebook) {
    selected = notebooks.filter(
      (nb) => nb.id === targetNotebook || nb.name === targetNotebook
    );
  } else if (limit > 0) {
    const testNb = notebooks.find((nb) => nb.name === "zz-uji-paralel-3");
    const others = notebooks.filter((nb) => nb.name !== "zz-uji-paralel-3");
    selected = testNb ? [testNb, ...others.slice(0, limit - 1)] : others.slice(0, limit);
  }

  console.log(`Surveying ${selected.length} notebook(s)...`);

  const allVerdicts: CellVerdict[] = [];
  const skippedNotebooks: Array<{ name: string; id: string; reason: string }> = [];

  for (let idx = 0; idx < selected.length; idx++) {
    const nb = selected[idx];
    console.log(`\n[${idx + 1}/${selected.length}] Notebook: ${nb.name} (${nb.id})`);
    try {
      const verdicts = await censusNotebook(nb.id, replays, ledgerPath, resultsPath);
      if (verdicts.length === 0) {
        skippedNotebooks.push({
          name: nb.name,
          id: nb.id,
          reason: "No successful executable cells in baseline run",
        });
        console.log(`  ⚠ Skipped: no successful executable cells in baseline run`);
      } else {
        allVerdicts.push(...verdicts);
        for (const v of verdicts) {
          if (v.deterministic) {
            console.log(`  ✓ cell ${v.cellId}: deterministic (${v.replays}/${v.replays})`);
          } else {
            const causesList = v.causes.join(", ");
            const ambiguousTag = v.ambiguous ? " (ambiguous / multiple causes)" : "";
            console.log(
              `  ✗ cell ${v.cellId}: non-deterministic (${v.distinctOutputs} distinct outputs) [causes: ${causesList}${ambiguousTag}]`
            );
          }
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      skippedNotebooks.push({
        name: nb.name,
        id: nb.id,
        reason: message,
      });
      console.error(`  ⚠ Skipped notebook ${nb.name}: ${message}`);
    }
  }

  // Summary statistics
  const totalCells = allVerdicts.length;
  const deterministicCount = allVerdicts.filter((v) => v.deterministic).length;
  const nonDeterministicCount = allVerdicts.filter((v) => !v.deterministic).length;
  const ambiguousCellsCount = allVerdicts.filter((v) => v.ambiguous).length;

  const causeCounts: Record<DeterminismCause, number> = {
    "wall-clock": 0,
    prng: 0,
    network: 0,
    "iteration-order": 0,
    unknown: 0,
  };

  const causeAmbiguousCounts: Record<DeterminismCause, number> = {
    "wall-clock": 0,
    prng: 0,
    network: 0,
    "iteration-order": 0,
    unknown: 0,
  };

  for (const v of allVerdicts) {
    for (const c of v.causes) {
      causeCounts[c]++;
      if (v.ambiguous) {
        causeAmbiguousCounts[c]++;
      }
    }
  }

  const ratio = totalCells > 0 ? (deterministicCount / totalCells).toFixed(4) : "0";

  console.log("\n" + "=".repeat(55));
  console.log("DETERMINISM CENSUS SUMMARY (H4)");
  console.log("=".repeat(55));
  console.log(`Notebooks in corpus:   ${notebooks.length}`);
  console.log(`Notebooks surveyed:    ${selected.length - skippedNotebooks.length}`);
  console.log(`Notebooks skipped:     ${skippedNotebooks.length}`);
  console.log(`Cells surveyed:        ${totalCells}`);
  console.log(`Deterministic:         ${deterministicCount}  (r = ${ratio})`);
  console.log(`Non-deterministic:     ${nonDeterministicCount}`);
  for (const [cause, count] of Object.entries(causeCounts) as [DeterminismCause, number][]) {
    const ambig = causeAmbiguousCounts[cause];
    const ambigNote = ambig > 0 ? `   (${ambig} ambiguous)` : "";
    console.log(`  ${cause.padEnd(21)}${count}${ambigNote}`);
  }
  console.log(`  cells with >1 cause  ${ambiguousCellsCount}`);

  if (skippedNotebooks.length > 0) {
    console.log("\nSkipped Notebooks Breakdown:");
    for (const sn of skippedNotebooks) {
      console.log(`  - ${sn.name} (${sn.id}): ${sn.reason}`);
    }
  }
  console.log("=".repeat(55));
}

main().catch((err) => {
  console.error("Census failed:", err);
  process.exit(1);
});
