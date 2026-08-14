import { createHash } from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Canonical JSON: object keys disortir rekursif; array TIDAK disortir (urutan bermakna). */
export function canonicalize(value: unknown): string {
  const ancestors = new WeakSet<object>();

  const serialize = (v: unknown): string => {
    if (v === null) return "null";
    const t = typeof v;
    if (t === "string") return JSON.stringify(v);
    if (t === "number") return Number.isFinite(v) ? String(v) : "null";
    if (t === "boolean") return v ? "true" : "false";
    if (t === "bigint") {
      throw new Error("canonicalize: unsupported type bigint — Rewind hashes JSON values only");
    }
    if (t === "undefined" || t === "function" || t === "symbol") return "null";

    const obj = v as object;
    const tag = Object.prototype.toString.call(obj);
    if (tag !== "[object Object]" && tag !== "[object Array]") {
      const typeName = tag.slice(8, -1);
      throw new Error(`canonicalize: unsupported type ${typeName} — Rewind hashes JSON values only`);
    }
    if (ancestors.has(obj)) {
      throw new Error("circular reference");
    }
    ancestors.add(obj);
    let body: string;
    if (Array.isArray(v)) {
      body = "[" + (v as unknown[]).map(serialize).join(",") + "]";
    } else {
      const record = v as Record<string, unknown>;
      const keys = Object.keys(record).sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0
      );
      const parts: string[] = [];
      for (const k of keys) {
        const val = record[k];
        const tv = typeof val;
        if (val === undefined || tv === "function" || tv === "symbol") continue;
        parts.push(JSON.stringify(k) + ":" + serialize(val));
      }
      body = "{" + parts.join(",") + "}";
    }
    ancestors.delete(obj);
    return body;
  };

  return serialize(value);
}

/** sha256 hex dari canonicalize(value). */
export function hashValue(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

/** sha256 hex dari string mentah — untuk source code (whitespace bermakna). */
export function hashSource(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export interface LedgerEntry {
  kind: "replay" | "mutation" | "arm";
  notebookId: string;
  cellId: string;
  sourceHash: string;
  scopeInHash: string;
  scopeOutHash: string | null;
  error: string | null;
  ms: number;
  at: string;
}

/** Append satu entry ke file JSONL. Buat file+folder jika belum ada. Flush tiap panggilan. */
export async function appendEntry(path: string, entry: LedgerEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
}