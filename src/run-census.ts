/**
 * CLI Runner for Determinism Census (R4)
 *
 * Usage:
 *   npx tsx src/run-census.ts --smoke
 *   npx tsx src/run-census.ts --replays=3 --limit=3
 *   npx tsx src/run-census.ts --replays=10
 */

import { listNotebooks } from "./client";
import { censusNotebook, type CellVerdict, type DeterminismCause } from "./determinism";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

async function main() {
  const args = process.argv.slice(2);
  const isSmoke = args.includes("--smoke");

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
    // Ensure zz-uji-paralel-3 is included in smoke test if present
    const testNb = notebooks.find((nb) => nb.name === "zz-uji-paralel-3");
    const others = notebooks.filter((nb) => nb.name !== "zz-uji-paralel-3");
    selected = testNb ? [testNb, ...others.slice(0, limit - 1)] : others.slice(0, limit);
  }

  console.log(`Surveying ${selected.length} notebook(s)...`);

  const allVerdicts: CellVerdict[] = [];

  for (let idx = 0; idx < selected.length; idx++) {
    const nb = selected[idx];
    console.log(`\n[${idx + 1}/${selected.length}] Notebook: ${nb.name} (${nb.id})`);
    try {
      const verdicts = await censusNotebook(nb.id, replays, ledgerPath, resultsPath);
      allVerdicts.push(...verdicts);

      for (const v of verdicts) {
        if (v.deterministic) {
          console.log(`  ✓ cell ${v.cellId}: deterministic (${v.replays}/${v.replays})`);
        } else {
          console.log(
            `  ✗ cell ${v.cellId}: non-deterministic (${v.distinctOutputs} distinct outputs) [cause: ${v.cause}]`
          );
        }
      }
    } catch (err: unknown) {
      console.error(`  Error running census on ${nb.name}:`, err);
    }
  }

  // Summary statistics
  const totalCells = allVerdicts.length;
  const deterministicCount = allVerdicts.filter((v) => v.deterministic).length;
  const nonDeterministicCount = allVerdicts.filter((v) => !v.deterministic).length;

  const causeCounts: Record<DeterminismCause, number> = {
    "wall-clock": 0,
    prng: 0,
    network: 0,
    "iteration-order": 0,
    unknown: 0,
  };

  for (const v of allVerdicts) {
    if (v.cause) {
      causeCounts[v.cause]++;
    }
  }

  const ratio = totalCells > 0 ? (deterministicCount / totalCells).toFixed(4) : "0";

  console.log("\n" + "=".repeat(50));
  console.log("DETERMINISM CENSUS SUMMARY");
  console.log("=".repeat(50));
  console.log(`Cells surveyed:        ${totalCells}`);
  console.log(`Deterministic:         ${deterministicCount}  (r = ${ratio})`);
  console.log(`Non-deterministic:     ${nonDeterministicCount}`);
  console.log(`  wall-clock           ${causeCounts["wall-clock"]}`);
  console.log(`  prng                 ${causeCounts["prng"]}`);
  console.log(`  network              ${causeCounts["network"]}`);
  console.log(`  iteration-order      ${causeCounts["iteration-order"]}`);
  console.log(`  unknown              ${causeCounts["unknown"]}`);
  console.log("=".repeat(50));
}

main().catch((err) => {
  console.error("Census failed:", err);
  process.exit(1);
});
