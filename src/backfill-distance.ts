/**
 * Backfill distanceToTerminal and distBand for Incidental Corpus (R7 Bagian 1)
 *
 * Reads results/mutations.jsonl, gets notebook documents via read-only REST GET,
 * calculates distanceToTerminal = terminal_index - cell_index,
 * assigns distBand ("direct", "short", "long", or "unknown" if cellId not found),
 * writes back to results/mutations.jsonl and joins to results/arms.jsonl.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getNotebook, outlineOfDocument } from "./client";
import { distBandForDistance, type Mutation, type DistBand } from "./mutate";
import type { ArmResult } from "./arms/types";

async function main() {
  const resultsDir = process.env.RESULTS_DIR || "./results";
  const mutationsPath = join(resultsDir, "mutations.jsonl");
  const armsPath = join(resultsDir, "arms.jsonl");

  if (!existsSync(mutationsPath)) {
    console.error(`File not found: ${mutationsPath}`);
    process.exit(1);
  }

  console.log(`Reading mutations from ${mutationsPath}...`);
  const rawMutLines = readFileSync(mutationsPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const mutations: Mutation[] = rawMutLines.map((l) => JSON.parse(l));

  // Collect unique notebook IDs
  const uniqueNotebookIds = Array.from(new Set(mutations.map((m) => m.notebookId)));
  console.log(`Found ${mutations.length} mutations across ${uniqueNotebookIds.length} unique notebooks.`);

  // Fetch notebook docs read-only
  const notebookDocs = new Map<string, any>();
  for (const nbId of uniqueNotebookIds) {
    try {
      console.log(`Fetching notebook ${nbId}...`);
      const doc = await getNotebook(nbId);
      notebookDocs.set(nbId, doc);
    } catch (err: any) {
      console.warn(`Warning: Could not fetch notebook ${nbId}: ${err.message}`);
    }
  }

  let directCount = 0;
  let shortCount = 0;
  let longCount = 0;
  let unknownCount = 0;

  const mutationMap = new Map<string, { distanceToTerminal?: number; distBand: DistBand }>();

  // Process mutations
  for (const m of mutations) {
    const doc = notebookDocs.get(m.notebookId);
    if (!doc) {
      m.distBand = "unknown";
      delete m.distanceToTerminal;
      unknownCount++;
      mutationMap.set(m.id, { distBand: "unknown" });
      continue;
    }

    const outlineCells = outlineOfDocument(doc);
    const terminalIndex = outlineCells.length - 1;
    const cellIndex = outlineCells.findIndex((c) => c.cellId === m.cellId);

    if (cellIndex === -1 || terminalIndex < 0) {
      m.distBand = "unknown";
      delete m.distanceToTerminal;
      unknownCount++;
      mutationMap.set(m.id, { distBand: "unknown" });
    } else {
      const distance = terminalIndex - cellIndex;
      const band = distBandForDistance(distance);
      m.distanceToTerminal = distance;
      m.distBand = band;
      if (band === "direct") directCount++;
      else if (band === "short") shortCount++;
      else if (band === "long") longCount++;
      mutationMap.set(m.id, { distanceToTerminal: distance, distBand: band });
    }
  }

  console.log(`\nMutations backfill summary:`);
  console.log(`  direct:  ${directCount}`);
  console.log(`  short:   ${shortCount}`);
  console.log(`  long:    ${longCount}`);
  console.log(`  unknown: ${unknownCount}`);

  // Write back mutations.jsonl
  const updatedMutLines = mutations.map((m) => JSON.stringify(m)).join("\n") + "\n";
  writeFileSync(mutationsPath, updatedMutLines, "utf8");
  console.log(`Updated ${mutationsPath}`);

  // Update arms.jsonl if it exists
  if (existsSync(armsPath)) {
    console.log(`Reading arms results from ${armsPath}...`);
    const rawArmsLines = readFileSync(armsPath, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const arms: ArmResult[] = rawArmsLines.map((l) => JSON.parse(l));

    let armsUpdated = 0;
    for (const a of arms) {
      const backfilled = mutationMap.get(a.mutationId);
      if (backfilled) {
        a.distBand = backfilled.distBand;
        if (backfilled.distanceToTerminal !== undefined) {
          a.distanceToTerminal = backfilled.distanceToTerminal;
        } else {
          // @ts-ignore
          delete a.distanceToTerminal;
        }
        armsUpdated++;
      }
    }

    const updatedArmsLines = arms.map((a) => JSON.stringify(a)).join("\n") + "\n";
    writeFileSync(armsPath, updatedArmsLines, "utf8");
    console.log(`Updated ${armsUpdated} / ${arms.length} records in ${armsPath}`);
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
