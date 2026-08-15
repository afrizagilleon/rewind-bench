import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyCause,
  classifyCauses,
  isPermutation,
  censusNotebook,
  type CellVerdict,
} from "../src/determinism";
import * as clientModule from "../src/client";
import type { RunDetail } from "../src/client";

describe("R4 / R4.1 Determinism — classifyCauses, classifyCause & isPermutation", () => {
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
    // Without permutation proof -> unknown
    expect(classifyCauses(code, [1, 2], [3, 4])).toEqual(["unknown"]);
    // With permutation proof -> iteration-order
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

describe("R4 / R4.1 Determinism — censusNotebook", () => {
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

  it("runs census returning exact verdicts with causes and ambiguous fields", async () => {
    const doc = {
      id: "synthetic-nb",
      name: "synthetic-determinism-test",
      steps: [
        { id: "c1", kind: "cell", code: "return { x: 1 };" },
        { id: "c2", kind: "cell", code: "return { t: Date.now() };" },
        { id: "c3", kind: "cell", code: "return { r: Math.random() };" },
        { id: "c4", kind: "cell", code: "const res = await fetch(u); return { at: new Date().toISOString() };" },
      ],
    };

    const baselineRun: RunDetail = {
      id: "baseline-1",
      notebook_id: "synthetic-nb",
      status: "success",
      started_at: "2026-08-15T00:00:00Z",
      finished_at: "2026-08-15T00:00:01Z",
      cell_results: {
        c1: { output: { x: 1 }, written: ["x"], ms: 5 },
        c2: { output: { t: 1000 }, written: ["t"], ms: 5 },
        c3: { output: { r: 0.123 }, written: ["r"], ms: 5 },
        c4: { output: { at: "2026-08-15T00:00:00Z" }, written: ["at"], ms: 5 },
      },
    };

    vi.spyOn(clientModule, "getNotebook").mockResolvedValue(doc);
    vi.spyOn(clientModule, "runNotebook").mockResolvedValue(baselineRun);

    let replayCounter = 0;
    vi.spyOn(clientModule, "runCell").mockImplementation(
      async (_nbId: string, cellId: string) => {
        replayCounter++;
        if (cellId === "c1") {
          return { output: { x: 1 }, written: ["x"], ms: 2 };
        }
        if (cellId === "c2") {
          return { output: { t: Date.now() + replayCounter }, written: ["t"], ms: 2 };
        }
        if (cellId === "c3") {
          return { output: { r: replayCounter * 0.111 }, written: ["r"], ms: 2 };
        }
        if (cellId === "c4") {
          return { output: { at: `2026-08-15T00:00:0${replayCounter}Z` }, written: ["at"], ms: 2 };
        }
        throw new Error(`Unexpected cell: ${cellId}`);
      }
    );

    const replays = 5;
    const verdicts = await censusNotebook(
      "synthetic-nb",
      replays,
      ledgerPath,
      resultsPath
    );

    expect(verdicts).toHaveLength(4);

    // c1: deterministic
    expect(verdicts[0].cellId).toBe("c1");
    expect(verdicts[0].deterministic).toBe(true);
    expect(verdicts[0].distinctOutputs).toBe(1);
    expect(verdicts[0].cause).toBeNull();
    expect(verdicts[0].causes).toEqual([]);
    expect(verdicts[0].ambiguous).toBe(false);
    expect(verdicts[0].sample).toBeNull();

    // c2: wall-clock (single cause)
    expect(verdicts[1].cellId).toBe("c2");
    expect(verdicts[1].deterministic).toBe(false);
    expect(verdicts[1].distinctOutputs).toBe(5);
    expect(verdicts[1].cause).toBe("wall-clock");
    expect(verdicts[1].causes).toEqual(["wall-clock"]);
    expect(verdicts[1].ambiguous).toBe(false);
    expect(verdicts[1].sample).toBeDefined();

    // c3: prng (single cause)
    expect(verdicts[2].cellId).toBe("c3");
    expect(verdicts[2].deterministic).toBe(false);
    expect(verdicts[2].distinctOutputs).toBe(5);
    expect(verdicts[2].cause).toBe("prng");
    expect(verdicts[2].causes).toEqual(["prng"]);
    expect(verdicts[2].ambiguous).toBe(false);
    expect(verdicts[2].sample).toBeDefined();

    // c4: wall-clock + network (multiple causes / ambiguous)
    expect(verdicts[3].cellId).toBe("c4");
    expect(verdicts[3].deterministic).toBe(false);
    expect(verdicts[3].distinctOutputs).toBe(5);
    expect(verdicts[3].cause).toBe("wall-clock");
    expect(verdicts[3].causes).toEqual(["wall-clock", "network"]);
    expect(verdicts[3].ambiguous).toBe(true);
    expect(verdicts[3].sample).toBeDefined();

    // Verify determinism.jsonl was flushed per record
    expect(existsSync(resultsPath)).toBe(true);
    const lines = readFileSync(resultsPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(4);
    const v4 = JSON.parse(lines[3]) as CellVerdict;
    expect(v4.cellId).toBe("c4");
    expect(v4.ambiguous).toBe(true);
    expect(v4.causes).toEqual(["wall-clock", "network"]);
  });
});
