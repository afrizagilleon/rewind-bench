/**
 * Materialized Scope Replay (R3)
 *
 * Reconstructs the exact scope observed by a cell prior to its execution,
 * following zaatool's parallel lane forking and joining semantics.
 */

import { hashValue, hashSource, appendEntry, type LedgerEntry } from "./ledger";
import { runCell, type CellResult, type RunDetail } from "./client";

export interface MaterializedScope {
  scope: Record<string, unknown>;
  scopeHash: string;
  /** Cell IDs whose outputs were folded into this scope, in order of contribution. */
  contributedBy: string[];
  /** True if any upstream cell failed or lacked recorded output. */
  incomplete: boolean;
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
  id?: string;
  name?: string;
  runtime?: string;
  steps?: RawStep[];
}

type WalkResult =
  | { type: "found"; scope: MaterializedScope }
  | {
      type: "writes";
      writes: Record<string, unknown>;
      contributed: string[];
      incomplete: boolean;
    };

/**
 * Traverses the document step tree, propagating scope copies into parallel lanes (fork)
 * and merging lane outputs into the parent scope when all lanes finish (join).
 */
function walk(
  steps: RawStep[] | undefined,
  currentScope: Record<string, unknown>,
  currentContributed: string[],
  currentIncomplete: boolean,
  targetId: string,
  run: RunDetail
): WalkResult {
  const scope = { ...currentScope };
  const contributed = [...currentContributed];
  let incomplete = currentIncomplete;
  const localWrites: Record<string, unknown> = {};

  for (const step of steps ?? []) {
    if (step.kind === "cell" || !step.kind) {
      const code = step.code ?? "";
      // Cells with empty or whitespace-only code carry intent only and never execute
      if (code.trim().length === 0) {
        if (step.id === targetId) {
          return {
            type: "found",
            scope: {
              scope: { ...scope },
              scopeHash: hashValue(scope),
              contributedBy: [...contributed],
              incomplete,
            },
          };
        }
        continue;
      }

      if (step.id === targetId) {
        return {
          type: "found",
          scope: {
            scope: { ...scope },
            scopeHash: hashValue(scope),
            contributedBy: [...contributed],
            incomplete,
          },
        };
      }

      const cellRes = run.cell_results?.[step.id];
      if (!cellRes || cellRes.error || cellRes.output === undefined) {
        incomplete = true;
        continue;
      }

      // Shallow merge into scope and track local writes
      for (const [k, v] of Object.entries(cellRes.output)) {
        scope[k] = v;
        localWrites[k] = v;
      }
      contributed.push(step.id);
      continue;
    }

    if (step.kind === "parallel") {
      const laneWritesList: Array<{
        writes: Record<string, unknown>;
        contributed: string[];
        incomplete: boolean;
      }> = [];

      for (const lane of step.lanes ?? []) {
        // Fork: pass a COPY of scope and contributed cells, preserving isolation
        const laneRes = walk(
          lane.steps,
          { ...scope },
          [...contributed],
          incomplete,
          targetId,
          run
        );

        if (laneRes.type === "found") {
          return laneRes;
        }

        laneWritesList.push({
          writes: laneRes.writes,
          contributed: laneRes.contributed,
          incomplete: laneRes.incomplete,
        });
      }

      // Join: merge all lane writes into the current level's scope
      for (const lw of laneWritesList) {
        for (const [k, v] of Object.entries(lw.writes)) {
          scope[k] = v;
          localWrites[k] = v;
        }
        for (const id of lw.contributed) {
          if (!contributed.includes(id)) {
            contributed.push(id);
          }
        }
        if (lw.incomplete) {
          incomplete = true;
        }
      }
    }
  }

  return {
    type: "writes",
    writes: localWrites,
    contributed,
    incomplete,
  };
}

/**
 * Reconstructs the exact scope immediately preceding the execution of `cellId`.
 */
export function scopeBefore(
  document: unknown,
  run: RunDetail,
  cellId: string
): MaterializedScope {
  const doc = document as RawNotebookDoc;
  const result = walk(doc?.steps, {}, [], false, cellId, run);
  if (result.type === "found") {
    return result.scope;
  }
  throw new Error(`Cell "${cellId}" not found in notebook document`);
}

/**
 * Replays a single cell against a materialized scope and logs the result to a ledger JSONL file.
 */
export async function replayCell(
  notebookId: string,
  cellId: string,
  scope: MaterializedScope,
  source: string,
  ledgerPath: string
): Promise<{ result: CellResult; scopeOutHash: string | null }> {
  const result = await runCell(notebookId, cellId, scope.scope);
  const scopeOutHash =
    result.output && !result.error ? hashValue(result.output) : null;

  const entry: LedgerEntry = {
    kind: "replay",
    notebookId,
    cellId,
    sourceHash: hashSource(source),
    scopeInHash: scope.scopeHash,
    scopeOutHash,
    error: result.error ?? null,
    ms: result.ms ?? 0,
    at: new Date().toISOString(),
  };

  await appendEntry(ledgerPath, entry);

  return { result, scopeOutHash };
}
