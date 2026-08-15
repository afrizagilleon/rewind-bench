/**
 * Determinism Census (R4 / R4.1 / R4.2 / H4)
 *
 * Measures cell output reproducibility under identical materialized scopes
 * across multiple replays, classifies causes of non-determinism, distinguishes
 * transport failures from genuine cell output variation, and computes diffPaths.
 */

import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalize, hashSource } from "./ledger";
import { getNotebook, runNotebook } from "./client";
import { scopeBefore, replayCell } from "./msr";

export type DeterminismCause =
  | "wall-clock" // source mentions Date/now/timestamp
  | "prng" // Math.random / crypto.randomUUID / uuid
  | "network" // fetch/http/axios/notebooks.run
  | "iteration-order" // Object.keys/Set/Map without sort
  | "unknown";

export interface CellVerdict {
  notebookId: string;
  notebookName: string;
  cellId: string;
  sourceHash: string;
  scopeInHash: string;
  replays: number; // requested replays
  usableReplays: number; // replays that yielded data (success or genuine cell error)
  transportFailures: number; // discarded, reported, not counted in distinctOutputs
  distinctOutputs: number;
  deterministic: boolean; // distinctOutputs === 1 on usableReplays

  /** Dominant / first matching cause — kept for backward compatibility and compact tables. */
  cause: DeterminismCause | null;

  /** All matching causes in priority order. Can contain more than one. Empty array if deterministic. */
  causes: DeterminismCause[];

  /** True if more than one cause pattern matches (causes.length > 1). */
  ambiguous: boolean;

  sample: { first: unknown; differing: unknown } | null;

  /** JSON paths that differ between two samples, e.g. ["kept.url"]. Max 10. Empty array if deterministic. */
  diffPaths: string[];
}

interface RawStep {
  id: string;
  kind?: "cell" | "parallel" | string;
  code?: string;
  lanes?: Array<{
    id?: string;
    label?: string;
    steps?: RawStep[];
  }>;
}

interface RawNotebookDoc {
  id: string;
  name: string;
  runtime?: string;
  steps?: RawStep[];
}

/**
 * Checks whether two values are permutations of each other (e.g. arrays with same elements in different order).
 */
export function isPermutation(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const aCanonical = a.map((item) => canonicalize(item));
    const bCanonical = b.map((item) => canonicalize(item));
    const aSorted = [...aCanonical].sort().join("___SEP___");
    const bSorted = [...bCanonical].sort().join("___SEP___");
    return aSorted === bSorted;
  }

  if (
    typeof a === "object" &&
    a !== null &&
    typeof b === "object" &&
    b !== null &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const objA = a as Record<string, unknown>;
    const objB = b as Record<string, unknown>;
    const keysA = Object.keys(objA).sort();
    const keysB = Object.keys(objB).sort();
    if (keysA.length !== keysB.length) return false;
    if (keysA.some((k, idx) => k !== keysB[idx])) return false;

    let hasPermutedArray = false;
    for (const k of keysA) {
      if (canonicalize(objA[k]) === canonicalize(objB[k])) continue;
      if (isPermutation(objA[k], objB[k])) {
        hasPermutedArray = true;
      } else {
        return false;
      }
    }
    return hasPermutedArray;
  }

  return false;
}

/**
 * Recursively compares two outputs and returns the JSON property paths that differ (max 10 paths).
 */
export function findDiffPaths(
  a: unknown,
  b: unknown,
  prefix = "",
  maxPaths = 10
): string[] {
  const diffs: string[] = [];

  function compare(valA: unknown, valB: unknown, currentPath: string) {
    if (diffs.length >= maxPaths) return;

    if (canonicalize(valA) === canonicalize(valB)) {
      return;
    }

    const typeA = typeof valA;
    const typeB = typeof valB;

    if (typeA !== typeB || valA === null || valB === null) {
      diffs.push(currentPath);
      return;
    }

    if (Array.isArray(valA) && Array.isArray(valB)) {
      const maxLen = Math.max(valA.length, valB.length);
      for (let i = 0; i < maxLen; i++) {
        const itemPath = currentPath ? `${currentPath}.${i}` : `${i}`;
        if (i >= valA.length || i >= valB.length) {
          diffs.push(itemPath);
        } else {
          compare(valA[i], valB[i], itemPath);
        }
        if (diffs.length >= maxPaths) return;
      }
      return;
    }

    if (
      typeA === "object" &&
      typeB === "object" &&
      !Array.isArray(valA) &&
      !Array.isArray(valB)
    ) {
      const objA = valA as Record<string, unknown>;
      const objB = valB as Record<string, unknown>;
      const allKeys = Array.from(
        new Set([...Object.keys(objA), ...Object.keys(objB)])
      ).sort();

      for (const key of allKeys) {
        const propPath = currentPath ? `${currentPath}.${key}` : key;
        if (!(key in objA) || !(key in objB)) {
          diffs.push(propPath);
        } else {
          compare(objA[key], objB[key], propPath);
        }
        if (diffs.length >= maxPaths) return;
      }
      return;
    }

    // Primitive value difference
    diffs.push(currentPath);
  }

  compare(a, b, prefix);
  return diffs.slice(0, maxPaths);
}

/**
 * Classifies all matching causes of non-determinism in priority order.
 */
export function classifyCauses(
  source: string,
  first?: unknown,
  differing?: unknown
): DeterminismCause[] {
  const causes: DeterminismCause[] = [];

  // 1. PRNG: Math.random | randomUUID | randomBytes | uuid
  if (/Math\.random|randomUUID|randomBytes|\buuid\b/.test(source)) {
    causes.push("prng");
  }

  // 2. Wall-clock: Date.now | new Date | performance.now | toISOString | Date()
  if (/Date\.now|new Date|performance\.now|toISOString|Date\(\)/.test(source)) {
    causes.push("wall-clock");
  }

  // 3. Network: fetch | http:// | https:// | axios | notebooks.run
  if (/\bfetch\s*\(|https?:\/\/|axios|notebooks\.run/.test(source)) {
    causes.push("network");
  }

  // 4. Iteration order: Object.keys | Object.entries | new Set | new Map with permuted outputs
  if (/Object\.keys|Object\.entries|new Set|new Map/.test(source)) {
    if (
      first !== undefined &&
      differing !== undefined &&
      isPermutation(first, differing)
    ) {
      causes.push("iteration-order");
    }
  }

  // 5. Unknown if no patterns matched
  if (causes.length === 0) {
    causes.push("unknown");
  }

  return causes;
}

/**
 * Classifies the dominant cause of non-determinism (first match wins).
 */
export function classifyCause(
  source: string,
  first: unknown,
  differing: unknown
): DeterminismCause {
  const causes = classifyCauses(source, first, differing);
  return causes[0];
}

/**
 * Extracts all executable cells from a notebook document step hierarchy.
 */
function getExecutableCells(
  steps: RawStep[] | undefined
): Array<{ id: string; code: string }> {
  const cells: Array<{ id: string; code: string }> = [];
  function walk(s: RawStep[] | undefined) {
    for (const step of s ?? []) {
      if (step.kind === "parallel") {
        for (const lane of step.lanes ?? []) {
          walk(lane.steps);
        }
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

/**
 * Appends a CellVerdict record to the verdicts JSONL file, flushing immediately.
 */
export async function appendVerdict(
  path: string,
  verdict: CellVerdict
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(verdict) + "\n", "utf8");
}

/**
 * Runs a determinism census on a single notebook:
 * 1. Runs full baseline once.
 * 2. For each successful cell, materializes scopeBefore and replays `replays` times with identical scope.
 * 3. Handles transport failures (missing cell in successful run) by retrying once after 300ms, discarding if still missing.
 * 4. Computes distinct outputs, diffPaths, and causes, writing to ledger and verdicts JSONL immediately.
 */
export async function censusNotebook(
  notebookId: string,
  replays = 10,
  ledgerPath = "./results/ledger.jsonl",
  resultsPath = "./results/determinism.jsonl"
): Promise<CellVerdict[]> {
  const doc = (await getNotebook(notebookId)) as RawNotebookDoc;
  const notebookName = doc.name || notebookId;

  // 1. Run baseline run
  const baseline = await runNotebook(notebookId);

  const executableCells = getExecutableCells(doc.steps);
  const verdicts: CellVerdict[] = [];

  // 2. Survey each cell that executed successfully in baseline
  for (const cell of executableCells) {
    const baselineResult = baseline.cell_results?.[cell.id];
    // Only census cells that succeeded in baseline
    if (
      !baselineResult ||
      baselineResult.error ||
      baselineResult.output === undefined
    ) {
      continue;
    }

    const scope = scopeBefore(doc, baseline, cell.id);
    const source = cell.code;
    const sourceHash = hashSource(source);
    const scopeInHash = scope.scopeHash;

    const replayOutputs: Array<{
      output: unknown;
      scopeOutHash: string | null;
    }> = [];
    let usableReplays = 0;
    let transportFailures = 0;

    // Replay cell `replays` times with identical materialized scope
    for (let r = 0; r < replays; r++) {
      let { result, scopeOutHash } = await replayCell(
        notebookId,
        cell.id,
        scope,
        source,
        ledgerPath
      );

      // Distinguish transport failure (missing cell result) from genuine cell error
      if (result.error === "Cell result not found in run detail") {
        // Wait 300ms and retry fetching/replaying once
        await new Promise((resolve) => setTimeout(resolve, 300));
        const retried = await replayCell(
          notebookId,
          cell.id,
          scope,
          source,
          ledgerPath
        );
        result = retried.result;
        scopeOutHash = retried.scopeOutHash;
      }

      if (result.error === "Cell result not found in run detail") {
        transportFailures++;
        continue; // Discarded from usable data and distinctOutputs
      }

      usableReplays++;
      replayOutputs.push({
        output: result.output,
        scopeOutHash,
      });
    }

    const distinctHashes = new Set(replayOutputs.map((ro) => ro.scopeOutHash));
    const distinctOutputs = distinctHashes.size;
    const deterministic = usableReplays > 0 && distinctOutputs === 1;

    let cause: DeterminismCause | null = null;
    let causes: DeterminismCause[] = [];
    let ambiguous = false;
    let sample: { first: unknown; differing: unknown } | null = null;
    let diffPaths: string[] = [];

    if (!deterministic && usableReplays > 1) {
      const first = replayOutputs[0].output;
      const firstHash = replayOutputs[0].scopeOutHash;
      const differingEntry = replayOutputs.find(
        (ro) => ro.scopeOutHash !== firstHash
      );
      const differing = differingEntry ? differingEntry.output : undefined;

      causes = classifyCauses(source, first, differing);
      cause = causes[0];
      ambiguous = causes.length > 1;
      sample = { first, differing };
      diffPaths = findDiffPaths(first, differing);
    }

    const verdict: CellVerdict = {
      notebookId,
      notebookName,
      cellId: cell.id,
      sourceHash,
      scopeInHash,
      replays,
      usableReplays,
      transportFailures,
      distinctOutputs,
      deterministic,
      cause,
      causes,
      ambiguous,
      sample,
      diffPaths,
    };

    // 3. Write verdict append-only immediately
    await appendVerdict(resultsPath, verdict);
    verdicts.push(verdict);
  }

  return verdicts;
}
