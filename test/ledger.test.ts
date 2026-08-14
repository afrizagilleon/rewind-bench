import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  canonicalize,
  hashValue,
  hashSource,
  appendEntry,
  type LedgerEntry,
} from "../src/ledger";
import { readFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const makeEntry = (i: number): LedgerEntry => ({
  kind: "replay",
  notebookId: "nb",
  cellId: `c${i}`,
  sourceHash: hashSource(`s${i}`),
  scopeInHash: hashValue({ n: i }),
  scopeOutHash: hashValue({ out: i }),
  error: null,
  ms: i * 10,
  at: new Date().toISOString(),
});

describe("canonicalize / hashValue", () => {
  it("urutan key tidak berpengaruh", () => {
    expect(hashValue({ a: 1, b: 2 })).toBe(hashValue({ b: 2, a: 1 }));
  });

  it("nested key juga diurutkan", () => {
    expect(hashValue({ x: { p: 1, q: 2 } })).toBe(
      hashValue({ x: { q: 2, p: 1 } })
    );
  });

  it("urutan array BERPENGARUH", () => {
    expect(hashValue([1, 2])).not.toBe(hashValue([2, 1]));
  });

  it("undefined dibuang dari object", () => {
    expect(hashValue({ a: 1, b: undefined })).toBe(hashValue({ a: 1 }));
  });

  it("tipe tidak tertukar: string vs number", () => {
    expect(hashValue("1")).not.toBe(hashValue(1));
  });

  it("tipe tidak tertukar: null vs string null", () => {
    expect(hashValue(null)).not.toBe(hashValue("null"));
  });

  it("undefined di array menjadi null", () => {
    expect(canonicalize([undefined, 1])).toBe(canonicalize([null, 1]));
  });

  it("NaN / Infinity menjadi null", () => {
    expect(canonicalize(NaN)).toBe("null");
    expect(canonicalize(Infinity)).toBe("null");
    expect(canonicalize(-Infinity)).toBe("null");
    expect(hashValue([NaN])).toBe(hashValue([null]));
  });

  it("sirkular melempar, bukan hang", () => {
    const c: Record<string, unknown> = {};
    c.self = c;
    expect(() => hashValue(c)).toThrow(/circular/);
  });

  it("sortir rekursif tanpa batas kedalaman", () => {
    const a = { z: 1, a: { y: 2, b: { q: 3, c: 4 } } };
    const b = { a: { b: { c: 4, q: 3 }, y: 2 }, z: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });
});

describe("hashSource", () => {
  it("sensitif whitespace", () => {
    expect(hashSource("a = 1")).not.toBe(hashSource("a=1"));
  });

  it("source identik → hash identik", () => {
    expect(hashSource("a = 1")).toBe(hashSource("a = 1"));
  });
});

describe("appendEntry", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rewind-ledger-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("3 append → 3 baris, masing-masing JSON valid", async () => {
    const path = join(dir, "ledger.jsonl");
    for (let i = 0; i < 3; i++) {
      await appendEntry(path, makeEntry(i));
      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(i + 1);
    }
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const obj = JSON.parse(line) as LedgerEntry;
      expect(obj.kind).toBe("replay");
      expect(obj.notebookId).toBe("nb");
      expect(obj.cellId).toMatch(/^c\d$/);
    }
  });

  it("membuat file + folder jika belum ada", async () => {
    const path = join(dir, "nested", "deep", "ledger.jsonl");
    expect(existsSync(path)).toBe(false);
    await appendEntry(path, makeEntry(0));
    expect(existsSync(path)).toBe(true);
    const obj = JSON.parse(readFileSync(path, "utf8")) as LedgerEntry;
    expect(obj.cellId).toBe("c0");
  });
});

describe("R1.1 — tolak tipe yang tidak bisa direpresentasikan", () => {
  it("Date melempar", () => {
    expect(() => hashValue({ t: new Date() })).toThrow(/unsupported type Date/);
  });

  it("Set melempar", () => {
    expect(() => hashValue({ s: new Set([1]) })).toThrow(/unsupported type Set/);
  });

  it("Map melempar", () => {
    expect(() => hashValue({ m: new Map() })).toThrow(/unsupported type Map/);
  });

  it("RegExp melempar", () => {
    expect(() => hashValue({ r: /x/ })).toThrow(/unsupported type RegExp/);
  });

  it("bigint melempar", () => {
    expect(() => hashValue(123n)).toThrow(/unsupported type bigint/);
  });

  it("TypedArray (Uint8Array) melempar", () => {
    expect(() => hashValue({ b: new Uint8Array([1]) })).toThrow(/unsupported type/);
  });

  it("nested juga melempar, bukan hanya di akar", () => {
    expect(() => hashValue({ a: { b: [{ c: new Date() }] } })).toThrow(
      /unsupported type Date/
    );
  });

  it("Object.create(null) diterima sebagai plain object", () => {
    expect(() => hashValue(Object.create(null))).not.toThrow();
  });

  it("referensi bersama bukan sirkular — tidak melempar", () => {
    const shared = { x: 1 };
    expect(() => hashValue({ a: shared, b: shared })).not.toThrow();
  });
});