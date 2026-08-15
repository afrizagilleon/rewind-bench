import { describe, it, expect } from "vitest";
import {
  mutationsFor,
  isValidSyntax,
  stratumForKind,
  cellReads,
  cellWrites,
  computeHopDistances,
  hopBandForDistance,
} from "../src/mutate";

describe("R5, R5.1 & R9 Mutation Engine — AST Analysis & Operators", () => {
  const nbId = "test-nb-1";
  const nbName = "test-nb";
  const cellId = "cell-1";

  it("cellReads extracts inputs property accesses", () => {
    const code = "const x = inputs.rows; const y = inputs['total']; return { x, y };";
    const reads = cellReads(code);
    expect(reads).toContain("rows");
    expect(reads).toContain("total");
    expect(reads).toHaveLength(2);
  });

  it("cellWrites detects object keys including shorthand return { langkah } and ignores inner functions", () => {
    const code = `
      const langkah = ['1', '2'];
      const helper = () => ({ ignored: true });
      return { langkah, total: 42 };
    `;
    const writes = cellWrites(code);
    expect(writes).toContain("langkah");
    expect(writes).toContain("total");
    expect(writes).not.toContain("ignored");
  });

  it("computeHopDistances calculates DAG hop distance correctly across pipeline", () => {
    const steps = [
      { id: "c1", code: "return { root: 100 };" },
      { id: "c2", code: "const a = inputs.root + 1; return { a };" },
      { id: "c3", code: "const b = inputs.a + 1; return { b };" },
      { id: "c4", code: "const c = inputs.b + 1; return { c };" },
    ];
    const hops = computeHopDistances(steps);
    expect(hops.get("c1")?.hopDistance).toBe(0);
    expect(hops.get("c1")?.readsFromUpstream).toBe(false);

    expect(hops.get("c2")?.hopDistance).toBe(1);
    expect(hops.get("c2")?.readsFromUpstream).toBe(true);
    expect(hops.get("c2")?.hopBand).toBe("near");

    expect(hops.get("c3")?.hopDistance).toBe(2);
    expect(hops.get("c3")?.readsFromUpstream).toBe(true);
    expect(hops.get("c3")?.hopBand).toBe("near");

    expect(hops.get("c4")?.hopDistance).toBe(3);
    expect(hops.get("c4")?.readsFromUpstream).toBe(true);
    expect(hops.get("c4")?.hopBand).toBe("mid");
  });

  it("hopBandForDistance categorizes near, mid, and far bands", () => {
    expect(hopBandForDistance(1)).toBe("near");
    expect(hopBandForDistance(2)).toBe("near");
    expect(hopBandForDistance(3)).toBe("mid");
    expect(hopBandForDistance(6)).toBe("mid");
    expect(hopBandForDistance(7)).toBe("far");
    expect(hopBandForDistance(15)).toBe("far");
  });

  it("key-rename renames returned keys using synonyms dictionary", () => {
    const code = "return { total: 1 };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    const keyRename = mutations.find((m) => m.kind === "key-rename");
    expect(keyRename).toBeDefined();
    expect(keyRename?.mutatedSource).toBe("return { sum: 1 };");
    expect(keyRename?.stratum).toBe("name-level");
  });

  it("arith-swap swaps arithmetic operators (+ <-> -, * <-> /)", () => {
    const code = "const total = a + b; return { total };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    const arithSwap = mutations.find((m) => m.kind === "arith-swap");
    expect(arithSwap).toBeDefined();
    expect(arithSwap?.mutatedSource).toBe("const total = a - b; return { total };");
    expect(arithSwap?.stratum).toBe("value-level");
  });

  it("const-perturb mutates numeric constants", () => {
    const code = "const rate = 100; return { rate };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    const constPerturb = mutations.find((m) => m.kind === "const-perturb");
    expect(constPerturb).toBeDefined();
    expect(constPerturb?.mutatedSource).toBe("const rate = 101; return { rate };");
    expect(constPerturb?.stratum).toBe("value-level");
  });
});
