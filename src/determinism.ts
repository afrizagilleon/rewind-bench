/**
 * Determinism Census (R4 / R4.1 / H4)
 *
 * Measures cell output reproducibility under identical materialized scopes
 * across multiple replays and classifies causes of non-determinism, including
 * reporting all overlapping/ambiguous causes per cell.
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
  replays: number;
  distinctOutputs: number;
  deterministic: boolean; // distinctOutputs === 1

  /** Dominant / first matching cause — kept for backward compatibility and compact tables. */
  cause: DeterminismCause | null;

  /** All matching causes in priority order. Can contain more than one. Empty array if deterministic. */
  causes: DeterminismCause[];

  /** True if more than one cause pattern matches (causes.length > 1). */
  ambiguous: boolean;

  sample: { first: unknown; differing: unknown } | null;
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
    if (first !== undefined && differing !== undefined && isPermutation(first, differing)) {
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
 * 3. Logs each replay to ledgerPath and each verdict to resultsPath.
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
    if (!baselineResult || baselineResult.error || baselineResult.output === undefined) {
      continue;
    }

    const scope = scopeBefore(doc, baseline, cell.id);
    const source = cell.code;
    const sourceHash = hashSource(source);
    const scopeInHash = scope.scopeHash;

    const replayOutputs: Array<{ output: unknown; scopeOutHash: string | null }> = [];

    // Replay cell `replays` times with identical materialized scope
    for (let r = 0; r < replays; r++) {
      const { result, scopeOutHash } = await replayCell(
        notebookId,
        cell.id,
        scope,
        source,
        ledgerPath
      );
      replayOutputs.push({
        output: result.output,
        scopeOutHash,
      });
    }

    const distinctHashes = new Set(replayOutputs.map((ro) => ro.scopeOutHash));
    const distinctOutputs = distinctHashes.size;
    const deterministic = distinctOutputs === 1;

    let cause: DeterminismCause | null = null;
    let causes: DeterminismCause[] = [];
    let ambiguous = false;
    let sample: { first: unknown; differing: unknown } | null = null;

    if (!deterministic) {
      const first = replayOutputs[0].output;
      const firstHash = replayOutputs[0].scopeOutHash;
      const differingEntry = replayOutputs.find((ro) => ro.scopeOutHash !== firstHash);
      const differing = differingEntry ? differingEntry.output : undefined;

      causes = classifyCauses(source, first, differing);
      cause = causes[0];
      ambiguous = causes.length > 1;
      sample = { first, differing };
    }

    const verdict: CellVerdict = {
      notebookId,
      notebookName,
      cellId: cell.id,
      sourceHash,
      scopeInHash,
      replays,
      distinctOutputs,
      deterministic,
      cause,
      causes,
      ambiguous,
      sample,
    };

    // 3. Write verdict append-only immediately
    await appendVerdict(resultsPath, verdict);
    verdicts.push(verdict);
  }

  return verdicts;
}
