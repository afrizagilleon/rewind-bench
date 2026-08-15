import { describe, it, expect } from "vitest";
import {
  mutationsFor,
  isValidSyntax,
  stratumForKind,
  cellReads,
  cellWrites,
  computeHopDistances,
  hopBandForDistance,
  distBandForDistance,
} from "../src/mutate";

describe("R5, R5.1, R9 & R10.1 Mutation Engine — AST Analysis & Operators", () => {
  const nbId = "test-nb-1";
  const nbName = "test-nb";
  const cellId = "cell-1";

  it("cellReads extracts inputs property accesses including destructuring", () => {
    const code = "const { x, y } = inputs; const z = inputs.total; const w = inputs['items']; return { x, y, z, w };";
    const reads = cellReads(code);
    expect(reads).toContain("x");
    expect(reads).toContain("y");
    expect(reads).toContain("total");
    expect(reads).toContain("items");
    expect(reads).toHaveLength(4);
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

  it("distBandForDistance categorizes direct, short, and long distance bands (R10.1)", () => {
    expect(distBandForDistance(0)).toBe("direct");
    expect(distBandForDistance(1)).toBe("short");
    expect(distBandForDistance(2)).toBe("short");
    expect(distBandForDistance(3)).toBe("short");
    expect(distBandForDistance(4)).toBe("long");
    expect(distBandForDistance(7)).toBe("long");
  });

  it("key-rename renames returned keys using synonyms dictionary", () => {
    const code = "return { total: 10 };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    const keyRename = mutations.find((m) => m.kind === "key-rename");
    expect(keyRename).toBeDefined();
    expect(keyRename?.mutatedSource).toBe("return { sum: 10 };");
    expect(keyRename?.stratum).toBe("name-level");
  });

  it("key-rename renames returned keys without synonym using _v2 suffix", () => {
    const code = "return { customKey: 100 };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    const keyRename = mutations.find((m) => m.kind === "key-rename");
    expect(keyRename).toBeDefined();
    expect(keyRename?.mutatedSource).toBe("return { customKey_v2: 100 };");
    expect(keyRename?.stratum).toBe("name-level");
  });

  it("key-rename does NOT mutate return statements inside nested inner functions (R5 acceptance)", () => {
    const code = "const f = () => ({ a: 1 }); return { b: 2 };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    const keyRenames = mutations.filter((m) => m.kind === "key-rename");
    expect(keyRenames).toHaveLength(1);
    expect(keyRenames[0].mutatedSource).toBe("const f = () => ({ a: 1 }); return { b_v2: 2 };");
  });

  it("off-by-one shifts numeric slice/substring argument (R5 acceptance)", () => {
    const code = "return { n: xs.slice(0, k) };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    const offByOne = mutations.find((m) => m.kind === "off-by-one");
    expect(offByOne).toBeDefined();
    expect(offByOne?.mutatedSource).toBe("return { n: xs.slice(0, k - 1) };");
    expect(offByOne?.stratum).toBe("value-level");
  });

  it("off-by-one shifts comparison binary operators (< <-> <=, > <-> >=)", () => {
    const code = "if (a < b) return { valid: true };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    const offByOne = mutations.find((m) => m.kind === "off-by-one");
    expect(offByOne).toBeDefined();
    expect(offByOne?.mutatedSource).toBe("if (a <= b) return { valid: true };");
    expect(offByOne?.stratum).toBe("value-level");
  });

  it("dropped-await removes await from expressions (R5 acceptance)", () => {
    const code = "const r = await f(); return { r };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    const droppedAwait = mutations.find((m) => m.kind === "dropped-await");
    expect(droppedAwait).toBeDefined();
    expect(droppedAwait?.mutatedSource).toBe("const r = f(); return { r };");
    expect(droppedAwait?.stratum).toBe("value-level");
  });

  it("operand-swap swaps non-commutative binary expression operands (R5 acceptance)", () => {
    const code = "return { d: a - b };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    const operandSwap = mutations.find((m) => m.kind === "operand-swap");
    expect(operandSwap).toBeDefined();
    expect(operandSwap?.mutatedSource).toBe("return { d: b - a };");
    expect(operandSwap?.stratum).toBe("value-level");
  });

  it("type-coercion removes Number, String, parseInt wrappers (R5 acceptance)", () => {
    const code = "return { n: Number(x) };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    const typeCoercion = mutations.find((m) => m.kind === "type-coercion");
    expect(typeCoercion).toBeDefined();
    expect(typeCoercion?.mutatedSource).toBe("return { n: x };");
    expect(typeCoercion?.stratum).toBe("value-level");
  });

  it("arith-swap swaps arithmetic operators (+ <-> -, * <-> /)", () => {
    const code = "const total = a + b; return { total };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    const arithSwap = mutations.find((m) => m.kind === "arith-swap");
    expect(arithSwap).toBeDefined();
    expect(arithSwap?.mutatedSource).toBe("const total = a - b; return { total };");
    expect(arithSwap?.stratum).toBe("value-level");
  });

  it("const-perturb mutates numeric constants > 1 and skips 0 and 1 (R5.1/R10.1)", () => {
    const code = "const rate = 100; const zero = 0; const one = 1; return { rate };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    const constPerturb = mutations.filter((m) => m.kind === "const-perturb");
    expect(constPerturb).toHaveLength(1);
    expect(constPerturb[0].mutatedSource).toBe("const rate = 101; const zero = 0; const one = 1; return { rate };");
    expect(constPerturb[0].stratum).toBe("value-level");
  });

  it("comparison-flip flips equality and relational operators (=== <-> !==, < <-> >) (R5.1)", () => {
    const code = "const match = a === b; return { match };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    const compFlip = mutations.find((m) => m.kind === "comparison-flip");
    expect(compFlip).toBeDefined();
    expect(compFlip?.mutatedSource).toBe("const match = a !== b; return { match };");
    expect(compFlip?.stratum).toBe("value-level");
  });

  it("index-shift shifts computed member indices (R5.1)", () => {
    const code = "const item = rows[0]; return { item };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    const indexShift = mutations.find((m) => m.kind === "index-shift");
    expect(indexShift).toBeDefined();
    expect(indexShift?.mutatedSource).toBe("const item = rows[1]; return { item };");
    expect(indexShift?.stratum).toBe("value-level");
  });

  it("filter-invert inverts predicate in array filter/find/some (R5.1)", () => {
    const code = "const active = rows.filter(r => r.enabled); return { active };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    const filterInvert = mutations.find((m) => m.kind === "filter-invert");
    expect(filterInvert).toBeDefined();
    expect(filterInvert?.mutatedSource).toBe("const active = rows.filter(r => !(r.enabled)); return { active };");
    expect(filterInvert?.stratum).toBe("value-level");
  });

  it("stratumForKind returns correct stratum", () => {
    expect(stratumForKind("key-rename")).toBe("name-level");
    expect(stratumForKind("arith-swap")).toBe("value-level");
    expect(stratumForKind("const-perturb")).toBe("value-level");
    expect(stratumForKind("comparison-flip")).toBe("value-level");
    expect(stratumForKind("index-shift")).toBe("value-level");
    expect(stratumForKind("filter-invert")).toBe("value-level");
  });

  it("returns empty array for code without matching targets", () => {
    const code = "console.log('hi');";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    expect(mutations).toEqual([]);
  });

  it("all generated mutants are syntactically valid under zaatool wrapper (Layer 1)", () => {
    const code = "const r = await fetch(u); const diff = x - y; const item = arr[i]; return { total: Number(r.val) };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    expect(mutations.length).toBeGreaterThan(0);
    for (const m of mutations) {
      expect(isValidSyntax(m.mutatedSource)).toBe(true);
    }
  });
});
