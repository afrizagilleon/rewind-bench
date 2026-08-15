import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyCause,
  classifyCauses,
  isPermutation,
  findDiffPaths,
  censusNotebook,
  type CellVerdict,
} from "../src/determinism";
import * as clientModule from "../src/client";
import type { RunDetail } from "../src/client";

describe("R4.2 Determinism — findDiffPaths", () => {
  it("extracts exact diffPaths for signed-URL case (R4.2 acceptance)", () => {
    const a = { kept: { url: "http://storage.com/planted.txt?exp=1786798541106&sig=jD123" } };
    const b = { kept: { url: "http://storage.com/planted.txt?exp=1786798541388&sig=Oy456" } };
    expect(findDiffPaths(a, b)).toEqual(["kept.url"]);
  });

  it("extracts multiple nested diffPaths up to max 10", () => {
    const a = { x: 1, nested: { a: "old", b: 2 }, list: [1, 2] };
    const b = { x: 2, nested: { a: "new", b: 2 }, list: [1, 3] };
    expect(findDiffPaths(a, b)).toEqual(["list.1", "nested.a", "x"]);
  });

  it("returns empty array for identical outputs", () => {
    const a = { x: 1, y: { z: [1, 2] } };
    const b = { x: 1, y: { z: [1, 2] } };
    expect(findDiffPaths(a, b)).toEqual([]);
  });
});

describe("R4 / R4.1 / R4.2 Determinism — classifyCauses & isPermutation", () => {
  it("detects permutations correctly", () => {
    expect(isPermutation([1, 2, 3], [3, 1, 2])).toBe(true);
    expect(isPermutation(["a", "b"], ["b", "a"])).toBe(true);
    expect(isPermutation({ items: ["x", "y"] }, { items: ["y", "x"] })).toBe(true);

    expect(isPermutation([1, 2], [1, 3])).toBe(false);
    expect(isPermutation([1, 2], [1, 2, 3])).toBe(false);
    expect(isPermutation("str1", "str2")).toBe(false);
  });

  it("classifies single causes via classifyCauses and classifyCause", () => {
    expect(classifyCauses("return { r: Math.random() };")).toEqual(["prng"]);
    expect(classifyCause("return { r: Math.random() };", { r: 0.1 }, { r: 0.2 })).toBe("prng");

    expect(classifyCauses("return { started: Date.now() };")).toEqual(["wall-clock"]);
    expect(classifyCause("return { started: Date.now() };", { started: 100 }, { started: 200 })).toBe("wall-clock");

    expect(classifyCauses("const r = await fetch('https://api.com'); return { r };")).toEqual(["network"]);
    expect(classifyCause("const r = await fetch('https://api.com'); return { r };", { r: 1 }, { r: 2 })).toBe("network");
  });

  it("classifies multiple overlapping causes (R4.1 acceptance)", () => {
    const code = "const r = await fetch(u); return { t: new Date().toISOString() };";
    const causes = classifyCauses(code);
    expect(causes).toEqual(["wall-clock", "network"]);
    expect(classifyCause(code, {}, {})).toBe("wall-clock");
  });

  it("requires permutation proof for iteration-order (R4.1 acceptance)", () => {
    const code = "return { k: Object.keys(x) };";
    expect(classifyCauses(code, [1, 2], [3, 4])).toEqual(["unknown"]);
    expect(classifyCauses(code, [1, 2], [2, 1])).toEqual(["iteration-order"]);
  });

  it("prioritizes prng over wall-clock for dominant cause when source contains both", () => {
    const source = "return { r: Math.random(), t: Date.now() };";
    expect(classifyCauses(source)).toEqual(["prng", "wall-clock"]);
    expect(classifyCause(source, { r: 1, t: 10 }, { r: 2, t: 20 })).toBe("prng");
  });

  it("falls back to unknown when no heuristic matches", () => {
    const source = "return { count: externalState++ };";
    expect(classifyCauses(source)).toEqual(["unknown"]);
    expect(classifyCause(source, { count: 1 }, { count: 2 })).toBe("unknown");
  });
});

describe("R4.2 Determinism — censusNotebook & Transport Failure Handling", () => {
  let dir: string;
  let ledgerPath: string;
  let resultsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rewind-census-"));
    ledgerPath = join(dir, "ledger.jsonl");
    resultsPath = join(dir, "determinism.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("distinguishes transport failures from genuine cell output variation", async () => {
    const doc = {
      id: "synthetic-nb-transport",
      name: "synthetic-transport-test",
      steps: [
        { id: "c-normal", kind: "cell", code: "return { x: 1 };" },
        { id: "c-flaky-transport", kind: "cell", code: "return { b: 2 };" },
        { id: "c-cell-error", kind: "cell", code: "throw new Error('boom');" },
      ],
    };

    const baselineRun: RunDetail = {
      id: "baseline-1",
      notebook_id: "synthetic-nb-transport",
      status: "success",
      started_at: "2026-08-15T00:00:00Z",
      finished_at: "2026-08-15T00:00:01Z",
      cell_results: {
        "c-normal": { output: { x: 1 }, written: ["x"], ms: 5 },
        "c-flaky-transport": { output: { b: 2 }, written: ["b"], ms: 5 },
        "c-cell-error": { output: { err: 1 }, written: ["err"], ms: 5 },
      },
    };

    vi.spyOn(clientModule, "getNotebook").mockResolvedValue(doc);
    vi.spyOn(clientModule, "runNotebook").mockResolvedValue(baselineRun);

    let flakyCount = 0;
    vi.spyOn(clientModule, "runCell").mockImplementation(
      async (_nbId: string, cellId: string) => {
        if (cellId === "c-normal") {
          return { output: { x: 1 }, written: ["x"], ms: 2 };
        }
        if (cellId === "c-flaky-transport") {
          flakyCount++;
          // For replays 2 and 4 (including retry), return missing cell error
          if (flakyCount === 2 || flakyCount === 3 || flakyCount === 5 || flakyCount === 6) {
            return {
              error: "Cell result not found in run detail",
              ms: 0,
            };
          }
          return { output: { b: 2 }, written: ["b"], ms: 2 };
        }
        if (cellId === "c-cell-error") {
          // Genuine cell execution error (e.g. throw Error)
          return {
            error: "Genuine runtime error in cell",
            ms: 2,
          };
        }
        throw new Error(`Unexpected cell: ${cellId}`);
      }
    );

    const replays = 5;
    const verdicts = await censusNotebook(
      "synthetic-nb-transport",
      replays,
      ledgerPath,
      resultsPath
    );

    expect(verdicts).toHaveLength(3);

    // c-normal
    expect(verdicts[0].cellId).toBe("c-normal");
    expect(verdicts[0].replays).toBe(5);
    expect(verdicts[0].usableReplays).toBe(5);
    expect(verdicts[0].transportFailures).toBe(0);
    expect(verdicts[0].deterministic).toBe(true);
    expect(verdicts[0].diffPaths).toEqual([]);

    // c-flaky-transport: 2 transport failures, 3 usable replays with identical output
    expect(verdicts[1].cellId).toBe("c-flaky-transport");
    expect(verdicts[1].replays).toBe(5);
    expect(verdicts[1].transportFailures).toBe(2);
    expect(verdicts[1].usableReplays).toBe(3);
    // Invariant: usableReplays + transportFailures === replays
    expect(verdicts[1].usableReplays + verdicts[1].transportFailures).toBe(5);
    // Crucial: distinctOutputs only counts usable data (1 output: { b: 2 })
    expect(verdicts[1].distinctOutputs).toBe(1);
    expect(verdicts[1].deterministic).toBe(true);

    // c-cell-error: Genuine error is counted as usable data
    expect(verdicts[2].cellId).toBe("c-cell-error");
    expect(verdicts[2].replays).toBe(5);
    expect(verdicts[2].usableReplays).toBe(5);
    expect(verdicts[2].transportFailures).toBe(0);
    expect(verdicts[2].deterministic).toBe(true); // All 5 yielded null scopeOutHash
  });
});
