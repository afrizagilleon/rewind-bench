import { describe, it, expect } from "vitest";
import { mutationsFor, isValidSyntax } from "../src/mutate";

describe("R5 Mutation Engine — mutationsFor AST Operators", () => {
  const nbId = "test-nb-1";
  const nbName = "test-nb";
  const cellId = "cell-1";

  it("key-rename renames returned keys using synonyms dictionary (R5 acceptance)", () => {
    const code = "return { total: 1 };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    const keyRename = mutations.find((m) => m.kind === "key-rename");
    expect(keyRename).toBeDefined();
    expect(keyRename?.mutatedSource).toBe("return { sum: 1 };");
  });

  it("key-rename renames returned keys without synonym using _v2 suffix", () => {
    const code = "return { customKey: 100 };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    const keyRename = mutations.find((m) => m.kind === "key-rename");
    expect(keyRename).toBeDefined();
    expect(keyRename?.mutatedSource).toBe("return { customKey_v2: 100 };");
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
  });

  it("off-by-one shifts comparison binary operators (< <-> <=, > <-> >=)", () => {
    const code = "if (a < b) return { valid: true };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    const offByOne = mutations.find((m) => m.kind === "off-by-one");
    expect(offByOne).toBeDefined();
    expect(offByOne?.mutatedSource).toBe("if (a <= b) return { valid: true };");
  });

  it("dropped-await removes await from expressions (R5 acceptance)", () => {
    const code = "const r = await f(); return { r };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    const droppedAwait = mutations.find((m) => m.kind === "dropped-await");
    expect(droppedAwait).toBeDefined();
    expect(droppedAwait?.mutatedSource).toBe("const r = f(); return { r };");
  });

  it("operand-swap swaps non-commutative binary expression operands (R5 acceptance)", () => {
    const code = "return { d: a - b };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    const operandSwap = mutations.find((m) => m.kind === "operand-swap");
    expect(operandSwap).toBeDefined();
    expect(operandSwap?.mutatedSource).toBe("return { d: b - a };");
  });

  it("type-coercion removes Number, String, parseInt wrappers (R5 acceptance)", () => {
    const code = "return { n: Number(x) };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    const typeCoercion = mutations.find((m) => m.kind === "type-coercion");
    expect(typeCoercion).toBeDefined();
    expect(typeCoercion?.mutatedSource).toBe("return { n: x };");
  });

  it("returns empty array for code without matching targets (R5 acceptance)", () => {
    const code = "console.log('hi');";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    expect(mutations).toEqual([]);
  });

  it("all generated mutants are syntactically valid under zaatool wrapper (Layer 1)", () => {
    const code = "const r = await fetch(u); const diff = x - y; return { total: Number(r.val) };";
    const mutations = mutationsFor(nbId, nbName, cellId, code);
    expect(mutations.length).toBeGreaterThan(0);
    for (const m of mutations) {
      expect(isValidSyntax(m.mutatedSource)).toBe(true);
    }
  });
});
