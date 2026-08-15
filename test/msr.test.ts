import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopeBefore, replayCell, type MaterializedScope } from "../src/msr";
import { hashValue, hashSource, type LedgerEntry } from "../src/ledger";
import type { RunDetail } from "../src/client";
import * as clientModule from "../src/client";

const fixturesDir = join(__dirname, "..", "fixtures");

function readFixture<T = unknown>(filename: string): T {
  const content = readFileSync(join(fixturesDir, filename), "utf8");
  return JSON.parse(content) as T;
}

describe("R3 MSR — Linear Scope Reconstruction", () => {
  const syntheticDoc = {
    steps: [
      { id: "c1", kind: "cell", code: "return { a: 1 };" },
      { id: "c2", kind: "cell", code: "return { b: 2 };" },
      { id: "c3", kind: "cell", code: "return { a: 9 };" },
    ],
  };

  const syntheticRun: RunDetail = {
    id: "run-linear-1",
    notebook_id: "nb-linear",
    status: "success",
    started_at: "2026-08-15T00:00:00Z",
    finished_at: "2026-08-15T00:00:01Z",
    cell_results: {
      c1: { output: { a: 1 }, written: ["a"], ms: 10 },
      c2: { output: { b: 2 }, written: ["b"], ms: 10 },
      c3: { output: { a: 9 }, written: ["a"], ms: 10 },
    },
  };

  it("reconstructs scope for c1 as empty", () => {
    const s1 = scopeBefore(syntheticDoc, syntheticRun, "c1");
    expect(s1.scope).toEqual({});
    expect(s1.contributedBy).toEqual([]);
    expect(s1.incomplete).toBe(false);
    expect(s1.scopeHash).toBe(hashValue({}));
  });

  it("reconstructs scope for c2 with c1's output", () => {
    const s2 = scopeBefore(syntheticDoc, syntheticRun, "c2");
    expect(s2.scope).toEqual({ a: 1 });
    expect(s2.contributedBy).toEqual(["c1"]);
    expect(s2.incomplete).toBe(false);
    expect(s2.scopeHash).toBe(hashValue({ a: 1 }));
  });

  it("reconstructs scope for c3 with c1 and c2 output, avoiding off-by-one", () => {
    const s3 = scopeBefore(syntheticDoc, syntheticRun, "c3");
    expect(s3.scope).toEqual({ a: 1, b: 2 });
    expect(s3.contributedBy).toEqual(["c1", "c2"]);
    expect(s3.incomplete).toBe(false);
    // Crucial off-by-one check: c3 overwrites 'a' to 9, but only AFTER c3, NOT in c3's scopeBefore
    expect(s3.scope.a).toBe(1);
    expect(s3.scope.a).not.toBe(9);
  });

  it("marks incomplete when upstream cell has error", () => {
    const errorRun: RunDetail = {
      ...syntheticRun,
      cell_results: {
        c1: { output: { a: 1 }, written: ["a"], ms: 10 },
        c2: { error: "Execution failed", ms: 5 },
        c3: { output: { a: 9 }, written: ["a"], ms: 10 },
      },
    };

    const s3 = scopeBefore(syntheticDoc, errorRun, "c3");
    expect(s3.incomplete).toBe(true);
    expect(s3.scope).toEqual({ a: 1 });
    expect(s3.contributedBy).toEqual(["c1"]);
  });

  it("marks incomplete when upstream cell has missing output", () => {
    const missingRun: RunDetail = {
      ...syntheticRun,
      cell_results: {
        c1: { output: { a: 1 }, written: ["a"], ms: 10 },
        // c2 is absent from cell_results
        c3: { output: { a: 9 }, written: ["a"], ms: 10 },
      },
    };

    const s3 = scopeBefore(syntheticDoc, missingRun, "c3");
    expect(s3.incomplete).toBe(true);
    expect(s3.scope).toEqual({ a: 1 });
    expect(s3.contributedBy).toEqual(["c1"]);
  });

  it("produces identical scopeHash for semantically identical scopes", () => {
    const sA = scopeBefore(syntheticDoc, syntheticRun, "c3");
    const sB = scopeBefore(syntheticDoc, syntheticRun, "c3");
    expect(sA.scopeHash).toBe(sB.scopeHash);
    expect(sA.scopeHash).toBe(hashValue({ b: 2, a: 1 }));
  });

  it("throws Error if target cell is not found in document", () => {
    expect(() => scopeBefore(syntheticDoc, syntheticRun, "non-existent-cell")).toThrow(
      /not found/i
    );
  });
});

describe("R3 MSR — Parallel Lane Scope Reconstruction (Real Fixtures)", () => {
  const docParallel = readFixture("notebook-doc-parallel.json");
  const runParallel = readFixture<RunDetail>("run-detail-parallel.json");

  // Real fixture cell IDs
  const cellStarted = "a547f958-3a34-4d16-83d7-d38565025db3";
  const cellA1 = "d4f80f1b-b2c8-4e7c-a87c-5103d6b386ac";
  const cellB1 = "1a28481b-ce35-47ed-982f-a60658eb91e9";
  const cellB1a = "046fe5be-e251-4c19-8eed-ed023a359abb";
  const cellB2a = "056af417-d3eb-41dd-93fd-8ee3dc8a0d01";
  const cellC1 = "4fcdea6b-5b72-4986-b358-b642bfe6764f";
  const cellC2 = "7ca0c627-c5b2-40be-8d58-02885a5290a2";
  const cellJoin = "673ad773-5fe5-405f-9857-24c8764312f0";

  it("first cell (started) sees an empty scope", () => {
    const s = scopeBefore(docParallel, runParallel, cellStarted);
    expect(s.scope).toEqual({});
    expect(s.contributedBy).toEqual([]);
    expect(s.incomplete).toBe(false);
  });

  it("cell in lane A sees only started, not lane B writes", () => {
    const s = scopeBefore(docParallel, runParallel, cellA1);
    expect(s.scope).toHaveProperty("started");
    expect(s.scope).not.toHaveProperty("a1");
    expect(s.scope).not.toHaveProperty("b1");
    expect(s.contributedBy).toEqual([cellStarted]);
  });

  it("cell in lane B.1 (b1a) sees started and b1, but NOT a1, b2a, b1a, or c1/c2", () => {
    const s = scopeBefore(docParallel, runParallel, cellB1a);
    expect(s.scope).toHaveProperty("started");
    expect(s.scope).toHaveProperty("b1");

    // Core lane isolation guarantees:
    expect(s.scope).not.toHaveProperty("a1"); // concurrent lane A
    expect(s.scope).not.toHaveProperty("b2a"); // concurrent sibling lane B.2
    expect(s.scope).not.toHaveProperty("b1a"); // self
    expect(s.scope).not.toHaveProperty("c1"); // inside sibling lane B.2
    expect(s.scope).not.toHaveProperty("c2"); // inside sibling lane B.2

    expect(s.contributedBy).toEqual([cellStarted, cellB1]);
    expect(s.incomplete).toBe(false);
  });

  it("cell in lane B.2.i (c1) sees started, b1, b2a, but NOT a1, b1a, c1, c2", () => {
    const s = scopeBefore(docParallel, runParallel, cellC1);
    expect(s.scope).toHaveProperty("started");
    expect(s.scope).toHaveProperty("b1");
    expect(s.scope).toHaveProperty("b2a");

    expect(s.scope).not.toHaveProperty("a1");
    expect(s.scope).not.toHaveProperty("b1a");
    expect(s.scope).not.toHaveProperty("c1");
    expect(s.scope).not.toHaveProperty("c2");

    expect(s.contributedBy).toEqual([cellStarted, cellB1, cellB2a]);
  });

  it("join cell runs after all lanes finish and sees ALL writes from all lanes", () => {
    const j = scopeBefore(docParallel, runParallel, cellJoin);

    const expectedProperties = [
      "started",
      "a1",
      "b1",
      "b1a",
      "b2a",
      "c1",
      "c2",
    ];
    for (const name of expectedProperties) {
      expect(j.scope).toHaveProperty(name);
    }

    expect(j.contributedBy).toEqual([
      cellStarted,
      cellA1,
      cellB1,
      cellB1a,
      cellB2a,
      cellC1,
      cellC2,
    ]);
    expect(j.incomplete).toBe(false);
  });
});

describe("R3 MSR — replayCell Execution & Ledger Logging", () => {
  let dir: string;
  let ledgerPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rewind-msr-"));
    ledgerPath = join(dir, "ledger.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("replays cell, computes hashes, and appends LedgerEntry to JSONL", async () => {
    const mockOutput = { double: 10 };
    vi.spyOn(clientModule, "runCell").mockResolvedValue({
      output: mockOutput,
      written: ["double"],
      ms: 25,
    });

    const scope: MaterializedScope = {
      scope: { n: 5 },
      scopeHash: hashValue({ n: 5 }),
      contributedBy: ["c0"],
      incomplete: false,
    };

    const source = "return { double: inputs.n * 2 };";
    const res = await replayCell("nb-1", "c1", scope, source, ledgerPath);

    expect(res.result.output).toEqual(mockOutput);
    expect(res.scopeOutHash).toBe(hashValue(mockOutput));

    expect(existsSync(ledgerPath)).toBe(true);
    const content = readFileSync(ledgerPath, "utf8").trim();
    const entry = JSON.parse(content) as LedgerEntry;

    expect(entry.kind).toBe("replay");
    expect(entry.notebookId).toBe("nb-1");
    expect(entry.cellId).toBe("c1");
    expect(entry.sourceHash).toBe(hashSource(source));
    expect(entry.scopeInHash).toBe(scope.scopeHash);
    expect(entry.scopeOutHash).toBe(hashValue(mockOutput));
    expect(entry.error).toBeNull();
    expect(entry.ms).toBe(25);
    expect(typeof entry.at).toBe("string");
  });

  it("handles failed cell replay with null scopeOutHash and error in ledger entry", async () => {
    vi.spyOn(clientModule, "runCell").mockResolvedValue({
      error: "Division by zero",
      ms: 12,
    });

    const scope: MaterializedScope = {
      scope: { n: 0 },
      scopeHash: hashValue({ n: 0 }),
      contributedBy: [],
      incomplete: false,
    };

    const source = "throw new Error('Division by zero');";
    const res = await replayCell("nb-1", "c1", scope, source, ledgerPath);

    expect(res.result.error).toBe("Division by zero");
    expect(res.scopeOutHash).toBeNull();

    const content = readFileSync(ledgerPath, "utf8").trim();
    const entry = JSON.parse(content) as LedgerEntry;

    expect(entry.scopeOutHash).toBeNull();
    expect(entry.error).toBe("Division by zero");
    expect(entry.ms).toBe(12);
  });
});
