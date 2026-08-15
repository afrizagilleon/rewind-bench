import { describe, it, expect } from "vitest";
import { mutationsFor, isValidSyntax, stratumForKind } from "../src/mutate";

describe("R5 & R5.1 Mutation Engine — mutationsFor AST Operators", () => {
  const nbId = "test-nb-1";
  const nbName = "test-nb";
  const cellId = "cell-1";

  it("key-rename renames returned keys using synonyms dictionary (R5 acceptance)", () => {
    const code = "return { total: 1 };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    const keyRename = mutations.find((m) => m.kind === "key-rename");
    expect(keyRename).toBeDefined();
    expect(keyRename?.mutatedSource).toBe("return { sum: 1 };");
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

  it("arith-swap swaps arithmetic operators (+ <-> -, * <-> /) (R5.1)", () => {
    const code = "const total = a + b; return { total };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    const arithSwap = mutations.find((m) => m.kind === "arith-swap");
    expect(arithSwap).toBeDefined();
    expect(arithSwap?.mutatedSource).toBe("const total = a - b; return { total };");
    expect(arithSwap?.stratum).toBe("value-level");
  });

  it("const-perturb mutates numeric constants (R5.1)", () => {
    const code = "const rate = 100; return { rate };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    const constPerturb = mutations.find((m) => m.kind === "const-perturb");
    expect(constPerturb).toBeDefined();
    expect(constPerturb?.mutatedSource).toBe("const rate = 101; return { rate };");
    expect(constPerturb?.stratum).toBe("value-level");
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
