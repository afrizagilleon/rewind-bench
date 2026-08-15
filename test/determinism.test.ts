import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyCause,
  isPermutation,
  censusNotebook,
  type CellVerdict,
} from "../src/determinism";
import * as clientModule from "../src/client";
import type { RunDetail } from "../src/client";

describe("R4 Determinism — classifyCause & isPermutation", () => {
  it("detects permutations correctly", () => {
    expect(isPermutation([1, 2, 3], [3, 1, 2])).toBe(true);
    expect(isPermutation(["a", "b"], ["b", "a"])).toBe(true);
    expect(isPermutation({ items: ["x", "y"] }, { items: ["y", "x"] })).toBe(true);

    expect(isPermutation([1, 2], [1, 3])).toBe(false);
    expect(isPermutation([1, 2], [1, 2, 3])).toBe(false);
    expect(isPermutation("str1", "str2")).toBe(false);
  });

  it("classifies prng causes", () => {
    expect(classifyCause("return { r: Math.random() };", { r: 0.1 }, { r: 0.2 })).toBe("prng");
    expect(classifyCause("return { id: crypto.randomUUID() };", { id: "a" }, { id: "b" })).toBe("prng");
    expect(classifyCause("return { id: uuid() };", { id: "1" }, { id: "2" })).toBe("prng");
    expect(classifyCause("return { b: randomBytes(16) };", { b: "1" }, { b: "2" })).toBe("prng");
  });

  it("classifies wall-clock causes", () => {
    expect(classifyCause("return { started: Date.now() };", { started: 100 }, { started: 200 })).toBe("wall-clock");
    expect(classifyCause("return { at: new Date().toISOString() };", { at: "1" }, { at: "2" })).toBe("wall-clock");
    expect(classifyCause("return { t: performance.now() };", { t: 1 }, { t: 2 })).toBe("wall-clock");
    expect(classifyCause("return { d: Date() };", { d: "Sat" }, { d: "Sun" })).toBe("wall-clock");
  });

  it("classifies network causes", () => {
    expect(classifyCause("const r = await fetch('https://api.com'); return { r };", { r: 1 }, { r: 2 })).toBe("network");
    expect(classifyCause("const r = await axios.get('http://api.com'); return { r };", { r: 1 }, { r: 2 })).toBe("network");
    expect(classifyCause("const r = await notebooks.run('nb-id'); return { r };", { r: 1 }, { r: 2 })).toBe("network");
  });

  it("classifies iteration-order causes when outputs are permuted", () => {
    const source = "const s = new Set(['a', 'b']); return { items: Array.from(s) };";
    expect(classifyCause(source, { items: ["a", "b"] }, { items: ["b", "a"] })).toBe("iteration-order");
  });

  it("prioritizes prng over wall-clock when source contains both", () => {
    const source = "return { r: Math.random(), t: Date.now() };";
    expect(classifyCause(source, { r: 1, t: 10 }, { r: 2, t: 20 })).toBe("prng");
  });

  it("falls back to unknown when no heuristic matches", () => {
    const source = "return { count: externalState++ };";
    expect(classifyCause(source, { count: 1 }, { count: 2 })).toBe("unknown");
  });
});

describe("R4 Determinism — censusNotebook", () => {
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

  it("runs census on 3 known cells (deterministic, wall-clock, prng) returning exact verdicts", async () => {
    const doc = {
      id: "synthetic-nb",
      name: "synthetic-determinism-test",
      steps: [
        { id: "c1", kind: "cell", code: "return { x: 1 };" },
        { id: "c2", kind: "cell", code: "return { t: Date.now() };" },
        { id: "c3", kind: "cell", code: "return { r: Math.random() };" },
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

    expect(verdicts).toHaveLength(3);

    // c1: deterministic
    expect(verdicts[0].cellId).toBe("c1");
    expect(verdicts[0].deterministic).toBe(true);
    expect(verdicts[0].distinctOutputs).toBe(1);
    expect(verdicts[0].cause).toBeNull();
    expect(verdicts[0].sample).toBeNull();

    // c2: wall-clock
    expect(verdicts[1].cellId).toBe("c2");
    expect(verdicts[1].deterministic).toBe(false);
    expect(verdicts[1].distinctOutputs).toBe(5);
    expect(verdicts[1].cause).toBe("wall-clock");
    expect(verdicts[1].sample).toBeDefined();

    // c3: prng
    expect(verdicts[2].cellId).toBe("c3");
    expect(verdicts[2].deterministic).toBe(false);
    expect(verdicts[2].distinctOutputs).toBe(5);
    expect(verdicts[2].cause).toBe("prng");
    expect(verdicts[2].sample).toBeDefined();

    // Verify determinism.jsonl was flushed per record
    expect(existsSync(resultsPath)).toBe(true);
    const lines = readFileSync(resultsPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    const v1 = JSON.parse(lines[0]) as CellVerdict;
    expect(v1.cellId).toBe("c1");

    // Verify ledger.jsonl has 3 cells * 5 replays = 15 entries
    expect(existsSync(ledgerPath)).toBe(true);
    const ledgerLines = readFileSync(ledgerPath, "utf8").trim().split("\n");
    expect(ledgerLines).toHaveLength(15);
  });
});
