/**
 * Mutation Engine (R5 & R5.1 & R9 / Ground Truth)
 *
 * Generates synthetic single-point bugs using acorn AST transformations across 10 kinds:
 * Name-level:
 * - key-rename
 * Value-level:
 * - off-by-one
 * - operand-swap
 * - dropped-await
 * - type-coercion
 * - arith-swap
 * - const-perturb
 * - comparison-flip
 * - index-shift
 * - filter-invert
 *
 * R9 Enhancements:
 * - AST-based cellReads & cellWrites with shorthand support
 * - computeHopDistances DAG analysis (near: 1-2, mid: 3-6, far: 7+)
 * - Two-layer validation (syntax parsing and empirical behavioral deviation)
 * - Safe scratch notebook execution (zz-rewind-scratch-*)
 */

import { parse } from "acorn";
import { ancestor as walkAncestor } from "acorn-walk";
import { hashSource } from "./ledger";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type MutationKind =
  | "key-rename"
  | "off-by-one"
  | "operand-swap"
  | "dropped-await"
  | "type-coercion"
  | "arith-swap"
  | "const-perturb"
  | "comparison-flip"
  | "index-shift"
  | "filter-invert";

export type Stratum = "name-level" | "value-level";
export type HopBand = "near" | "mid" | "far";
export type DistBand = "direct" | "short" | "long" | "unknown";

export function stratumForKind(kind: MutationKind): Stratum {
  return kind === "key-rename" ? "name-level" : "value-level";
}

export function hopBandForDistance(hopDistance: number): HopBand {
  if (hopDistance <= 2) return "near";
  if (hopDistance <= 6) return "mid";
  return "far";
}

export function distBandForDistance(distance: number): DistBand {
  if (distance === 0) return "direct";
  if (distance <= 3) return "short";
  return "long";
}

export interface Mutation {
  id: string; // `${cellId}:${kind}:${index}`
  kind: MutationKind;
  stratum?: Stratum;
  hopDistance?: number;
  hopBand?: HopBand;
  distanceToTerminal?: number;
  distBand?: DistBand;
  notebookId: string;
  notebookName: string;
  cellId: string;
  originalSource: string;
  mutatedSource: string;
  description: string;
  sourceHash: string;
  baselineHash?: string;
  mutantHash?: string;
  mutantErrored?: boolean;
}

export interface CellHopInfo {
  cellId: string;
  hopDistance: number;
  hopBand: HopBand;
  readsFromUpstream: boolean;
  reads: string[];
  writes: string[];
}

const KEY_SYNONYMS: Record<string, string> = {
  total: "sum",
  sum: "total",
  rows: "items",
  items: "rows",
  result: "output",
  output: "result",
  data: "records",
  records: "data",
  count: "total_count",
  rate: "exchange_rate",
  rates: "exchange_rates",
  status: "state",
  state: "status",
  value: "val",
  val: "value",
  list: "array",
};

const WRAPPER_HEADER =
  "async function __cell(inputs, require, Table, FileObject, ImageObject, notebooks, files) {\n";
const WRAPPER_FOOTER = "\n}";
const WRAPPER_OFFSET = WRAPPER_HEADER.length;

function wrap(code: string): string {
  return `${WRAPPER_HEADER}${code}${WRAPPER_FOOTER}`;
}

/**
 * Validates that mutated code parses under zaatool's cell function wrapper.
 */
export function isValidSyntax(code: string): boolean {
  try {
    parse(wrap(code), { ecmaVersion: "latest", sourceType: "script" });
    return true;
  } catch {
    return false;
  }
}

/**
 * AST-based extraction of variables read from `inputs.foo` or `inputs["foo"]`.
 */
export function cellReads(code: string): string[] {
  const names = new Set<string>();
  let tree: any;
  try {
    tree = parse(wrap(code), { ecmaVersion: "latest", sourceType: "script" });
  } catch {
    return [];
  }

  walkAncestor(tree, {
    MemberExpression(node: any) {
      if (node.object?.type === "Identifier" && node.object.name === "inputs") {
        if (!node.computed && node.property?.type === "Identifier" && node.property.name) {
          names.add(node.property.name);
        } else if (node.computed && node.property?.type === "Literal" && typeof node.property.value === "string") {
          names.add(node.property.value);
        }
      }
    },
    VariableDeclarator(node: any) {
      if (node.init?.type === "Identifier" && node.init.name === "inputs") {
        if (node.id?.type === "ObjectPattern") {
          for (const prop of node.id.properties || []) {
            if (prop.type === "Property" && !prop.computed) {
              if (prop.key?.type === "Identifier") {
                names.add(prop.key.name);
              } else if (prop.key?.type === "Literal" && typeof prop.key.value === "string") {
                names.add(prop.key.value);
              }
            }
          }
        }
      }
    },
  });

  return Array.from(names);
}

/**
 * AST-based extraction of variables written in cell's top-level return object.
 * Properly recognizes shorthand `return { langkah };` and ignores nested callbacks.
 */
export function cellWrites(code: string): string[] {
  const names = new Set<string>();
  let tree: any;
  try {
    tree = parse(wrap(code), { ecmaVersion: "latest", sourceType: "script" });
  } catch {
    return [];
  }

  const FUNCTIONS = new Set([
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
  ]);

  const cellFunctionBody = (tree as any).body[0];

  function extractKeys(expression: any) {
    if (!expression) return;
    if (expression.type === "ObjectExpression") {
      for (const prop of expression.properties || []) {
        if (prop.type === "Property" && !prop.computed) {
          if (prop.key?.type === "Identifier") {
            names.add(prop.key.name);
          } else if (prop.key?.type === "Literal" && typeof prop.key.value === "string") {
            names.add(prop.key.value);
          }
        }
      }
    } else if (expression.type === "ConditionalExpression") {
      extractKeys(expression.consequent);
      extractKeys(expression.alternate);
    } else if (expression.type === "LogicalExpression") {
      extractKeys(expression.left);
      extractKeys(expression.right);
    } else if (expression.type === "AwaitExpression") {
      extractKeys(expression.argument);
    }
  }

  walkAncestor(cellFunctionBody, {
    ReturnStatement(node: any, ancestors: any[]) {
      const enclosing = [...ancestors].reverse().find((one) => FUNCTIONS.has(one.type));
      if (enclosing !== cellFunctionBody) return;
      extractKeys(node.argument);
    },
  });

  return Array.from(names);
}

/**
 * Computes hop distances for all cells in a notebook's steps according to DAG dataflow.
 */
export function computeHopDistances(steps: any[]): Map<string, CellHopInfo> {
  const result = new Map<string, CellHopInfo>();
  const producedVariables = new Map<string, number>();

  function walk(s?: any[]) {
    for (const step of s ?? []) {
      if (step.kind === "parallel") {
        for (const lane of step.lanes ?? []) {
          walk(lane.steps);
        }
        continue;
      }
      const code = step.code ?? "";
      if (code.trim().length === 0) continue;

      const reads = cellReads(code);
      const writes = cellWrites(code);

      const upstreamHops: number[] = [];
      for (const r of reads) {
        if (producedVariables.has(r)) {
          upstreamHops.push(producedVariables.get(r)!);
        }
      }

      let hopDistance = 0;
      let readsFromUpstream = false;

      if (upstreamHops.length > 0) {
        readsFromUpstream = true;
        hopDistance = 1 + Math.max(...upstreamHops);
      }

      const hopBand = hopBandForDistance(hopDistance);

      result.set(step.id, {
        cellId: step.id,
        hopDistance,
        hopBand,
        readsFromUpstream,
        reads,
        writes,
      });

      for (const w of writes) {
        producedVariables.set(w, hopDistance);
      }
    }
  }

  walk(steps);
  return result;
}

/**
 * Replaces a slice of string by [start, end] character indices.
 */
function replaceSlice(
  str: string,
  start: number,
  end: number,
  replacement: string
): string {
  return str.slice(0, start) + replacement + str.slice(end);
}

/**
 * Extracts all valid single-point syntax mutations for a cell's source code.
 */
export function mutationsFor(
  notebookId: string,
  notebookName: string,
  cellId: string,
  source: string
): Mutation[] {
  const mutations: Mutation[] = [];
  const sourceHash = hashSource(source);

  let ast: any;
  try {
    ast = parse(wrap(source), { ecmaVersion: "latest", sourceType: "script" });
  } catch {
    return [];
  }

  const kindCounters: Record<MutationKind, number> = {
    "key-rename": 0,
    "off-by-one": 0,
    "operand-swap": 0,
    "dropped-await": 0,
    "type-coercion": 0,
    "arith-swap": 0,
    "const-perturb": 0,
    "comparison-flip": 0,
    "index-shift": 0,
    "filter-invert": 0,
  };

  function isInsideInnerFunction(ancestors: any[]): boolean {
    for (let i = 2; i < ancestors.length - 1; i++) {
      const a = ancestors[i];
      if (
        a.type === "FunctionDeclaration" ||
        a.type === "FunctionExpression" ||
        a.type === "ArrowFunctionExpression"
      ) {
        return true;
      }
    }
    return false;
  }

  walkAncestor(ast, {
    // 1. key-rename: Property in top-level ReturnStatement ObjectExpression
    ReturnStatement(node: any, ancestors: any[]) {
      if (isInsideInnerFunction(ancestors)) return;
      if (!node.argument || node.argument.type !== "ObjectExpression") return;

      for (const prop of node.argument.properties) {
        if (prop.type !== "Property" || prop.computed) continue;

        let keyName: string | null = null;
        let isLiteral = false;

        if (prop.key.type === "Identifier") {
          keyName = prop.key.name;
        } else if (
          prop.key.type === "Literal" &&
          typeof prop.key.value === "string"
        ) {
          keyName = prop.key.value;
          isLiteral = true;
        }

        if (!keyName) continue;

        const newKeyName = KEY_SYNONYMS[keyName] || `${keyName}_v2`;
        let mutated: string;

        if (prop.shorthand) {
          const start = prop.start - WRAPPER_OFFSET;
          const end = prop.end - WRAPPER_OFFSET;
          mutated = replaceSlice(source, start, end, `${newKeyName}: ${keyName}`);
        } else {
          const start = prop.key.start - WRAPPER_OFFSET;
          const end = prop.key.end - WRAPPER_OFFSET;
          const replacement = isLiteral
            ? JSON.stringify(newKeyName)
            : newKeyName;
          mutated = replaceSlice(source, start, end, replacement);
        }

        if (isValidSyntax(mutated)) {
          const idx = kindCounters["key-rename"]++;
          mutations.push({
            id: `${cellId}:key-rename:${idx}`,
            kind: "key-rename",
            stratum: "name-level",
            notebookId,
            notebookName,
            cellId,
            originalSource: source,
            mutatedSource: mutated,
            description: `renamed returned key "${keyName}" to "${newKeyName}"`,
            sourceHash,
          });
        }
      }
    },

    // 2. BinaryExpression: off-by-one, comparison-flip, arith-swap, operand-swap
    BinaryExpression(node: any) {
      const op = node.operator;
      const leftEnd = node.left.end - WRAPPER_OFFSET;
      const rightStart = node.right.start - WRAPPER_OFFSET;
      const opRegion = source.slice(leftEnd, rightStart);
      const opIndexInRegion = opRegion.indexOf(op);

      if (opIndexInRegion !== -1) {
        const opStart = leftEnd + opIndexInRegion;
        const opEnd = opStart + op.length;

        // 2a. off-by-one (< <-> <=, > <-> >=)
        let offByOneOp: string | null = null;
        if (op === "<") offByOneOp = "<=";
        else if (op === "<=") offByOneOp = "<";
        else if (op === ">") offByOneOp = ">=";
        else if (op === ">=") offByOneOp = ">";

        if (offByOneOp) {
          const mutated = replaceSlice(source, opStart, opEnd, offByOneOp);
          if (isValidSyntax(mutated)) {
            const idx = kindCounters["off-by-one"]++;
            mutations.push({
              id: `${cellId}:off-by-one:${idx}`,
              kind: "off-by-one",
              stratum: "value-level",
              notebookId,
              notebookName,
              cellId,
              originalSource: source,
              mutatedSource: mutated,
              description: `changed "${op}" to "${offByOneOp}" in comparison`,
              sourceHash,
            });
          }
        }

        // 2b. comparison-flip (=== <-> !==, == <-> !=, < <-> >, <= <-> >=)
        let compFlipOp: string | null = null;
        if (op === "===") compFlipOp = "!==";
        else if (op === "!==") compFlipOp = "===";
        else if (op === "==") compFlipOp = "!=";
        else if (op === "!=") compFlipOp = "==";
        else if (op === "<") compFlipOp = ">";
        else if (op === ">") compFlipOp = "<";
        else if (op === "<=") compFlipOp = ">=";
        else if (op === ">=") compFlipOp = "<=";

        if (compFlipOp) {
          const mutated = replaceSlice(source, opStart, opEnd, compFlipOp);
          if (isValidSyntax(mutated)) {
            const idx = kindCounters["comparison-flip"]++;
            mutations.push({
              id: `${cellId}:comparison-flip:${idx}`,
              kind: "comparison-flip",
              stratum: "value-level",
              notebookId,
              notebookName,
              cellId,
              originalSource: source,
              mutatedSource: mutated,
              description: `flipped comparison operator "${op}" to "${compFlipOp}"`,
              sourceHash,
            });
          }
        }

        // 2c. arith-swap (+ <-> -, * <-> /)
        let arithOp: string | null = null;
        if (op === "+") arithOp = "-";
        else if (op === "-") arithOp = "+";
        else if (op === "*") arithOp = "/";
        else if (op === "/") arithOp = "*";

        if (arithOp) {
          const mutated = replaceSlice(source, opStart, opEnd, arithOp);
          if (isValidSyntax(mutated)) {
            const idx = kindCounters["arith-swap"]++;
            mutations.push({
              id: `${cellId}:arith-swap:${idx}`,
              kind: "arith-swap",
              stratum: "value-level",
              notebookId,
              notebookName,
              cellId,
              originalSource: source,
              mutatedSource: mutated,
              description: `swapped arithmetic operator "${op}" to "${arithOp}"`,
              sourceHash,
            });
          }
        }
      }

      // 2d. operand-swap: non-commutative (-, /, %, <, >)
      if (["-", "/", "%", "<", ">"].includes(op)) {
        const leftStart = node.left.start - WRAPPER_OFFSET;
        const leftEnd = node.left.end - WRAPPER_OFFSET;
        const rightStart = node.right.start - WRAPPER_OFFSET;
        const rightEnd = node.right.end - WRAPPER_OFFSET;

        const leftStr = source.slice(leftStart, leftEnd);
        const rightStr = source.slice(rightStart, rightEnd);
        const between = source.slice(leftEnd, rightStart);

        const swapped = `${rightStr}${between}${leftStr}`;
        const mutated = replaceSlice(source, leftStart, rightEnd, swapped);

        if (isValidSyntax(mutated)) {
          const idx = kindCounters["operand-swap"]++;
          mutations.push({
            id: `${cellId}:operand-swap:${idx}`,
            kind: "operand-swap",
            stratum: "value-level",
            notebookId,
            notebookName,
            cellId,
            originalSource: source,
            mutatedSource: mutated,
            description: `swapped operands of "${op}" to "${rightStr} ${op} ${leftStr}"`,
            sourceHash,
          });
        }
      }
    },

    // 3. CallExpression: off-by-one, type-coercion, filter-invert
    CallExpression(node: any) {
      // 3a. slice/substring/splice off-by-one
      if (
        node.callee?.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.property?.type === "Identifier" &&
        ["slice", "substring", "splice"].includes(node.callee.property.name)
      ) {
        const methodName = node.callee.property.name;
        const targetArg =
          node.arguments.length > 1
            ? node.arguments[1]
            : node.arguments.length === 1
              ? node.arguments[0]
              : null;

        if (targetArg) {
          let mutated: string | null = null;
          let desc = "";

          if (targetArg.type === "Identifier") {
            const start = targetArg.start - WRAPPER_OFFSET;
            const end = targetArg.end - WRAPPER_OFFSET;
            mutated = replaceSlice(source, start, end, `${targetArg.name} - 1`);
            desc = `changed ${methodName} argument "${targetArg.name}" to "${targetArg.name} - 1"`;
          } else if (
            targetArg.type === "Literal" &&
            typeof targetArg.value === "number"
          ) {
            const start = targetArg.start - WRAPPER_OFFSET;
            const end = targetArg.end - WRAPPER_OFFSET;
            mutated = replaceSlice(
              source,
              start,
              end,
              String(targetArg.value - 1)
            );
            desc = `changed ${methodName} argument "${targetArg.value}" to "${targetArg.value - 1}"`;
          }

          if (mutated && isValidSyntax(mutated)) {
            const idx = kindCounters["off-by-one"]++;
            mutations.push({
              id: `${cellId}:off-by-one:${idx}`,
              kind: "off-by-one",
              stratum: "value-level",
              notebookId,
              notebookName,
              cellId,
              originalSource: source,
              mutatedSource: mutated,
              description: desc,
              sourceHash,
            });
          }
        }
      }

      // 3b. type-coercion: Number(x), String(x), parseInt(x), parseFloat(x)
      if (
        node.callee?.type === "Identifier" &&
        ["Number", "String", "parseInt", "parseFloat"].includes(
          node.callee.name
        ) &&
        node.arguments.length >= 1
      ) {
        const fnName = node.callee.name;
        const arg0 = node.arguments[0];
        const arg0Str = source.slice(
          arg0.start - WRAPPER_OFFSET,
          arg0.end - WRAPPER_OFFSET
        );
        const start = node.start - WRAPPER_OFFSET;
        const end = node.end - WRAPPER_OFFSET;
        const mutated = replaceSlice(source, start, end, arg0Str);

        if (isValidSyntax(mutated)) {
          const idx = kindCounters["type-coercion"]++;
          mutations.push({
            id: `${cellId}:type-coercion:${idx}`,
            kind: "type-coercion",
            stratum: "value-level",
            notebookId,
            notebookName,
            cellId,
            originalSource: source,
            mutatedSource: mutated,
            description: `removed ${fnName}() coercion around "${arg0Str}"`,
            sourceHash,
          });
        }
      }

      // 3c. filter-invert: .filter(x => ...), .find(x => ...), .some(x => ...), .every(x => ...)
      if (
        node.callee?.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.property?.type === "Identifier" &&
        ["filter", "find", "some", "every"].includes(node.callee.property.name) &&
        node.arguments.length >= 1
      ) {
        const methodName = node.callee.property.name;
        const cb = node.arguments[0];
        if (cb.type === "ArrowFunctionExpression" && cb.body.type !== "BlockStatement") {
          const bodyStart = cb.body.start - WRAPPER_OFFSET;
          const bodyEnd = cb.body.end - WRAPPER_OFFSET;
          const bodyStr = source.slice(bodyStart, bodyEnd);
          const inverted = `!(${bodyStr})`;
          const mutated = replaceSlice(source, bodyStart, bodyEnd, inverted);

          if (isValidSyntax(mutated)) {
            const idx = kindCounters["filter-invert"]++;
            mutations.push({
              id: `${cellId}:filter-invert:${idx}`,
              kind: "filter-invert",
              stratum: "value-level",
              notebookId,
              notebookName,
              cellId,
              originalSource: source,
              mutatedSource: mutated,
              description: `inverted predicate in ${methodName}() to "!(${bodyStr})"`,
              sourceHash,
            });
          }
        }
      }
    },

    // 4. dropped-await: AwaitExpression
    AwaitExpression(node: any) {
      if (!node.argument) return;
      const start = node.start - WRAPPER_OFFSET;
      const end = node.end - WRAPPER_OFFSET;
      const argStart = node.argument.start - WRAPPER_OFFSET;
      const argEnd = node.argument.end - WRAPPER_OFFSET;
      const argStr = source.slice(argStart, argEnd);

      const mutated = replaceSlice(source, start, end, argStr);

      if (isValidSyntax(mutated)) {
        const idx = kindCounters["dropped-await"]++;
        mutations.push({
          id: `${cellId}:dropped-await:${idx}`,
          kind: "dropped-await",
          stratum: "value-level",
          notebookId,
          notebookName,
          cellId,
          originalSource: source,
          mutatedSource: mutated,
          description: `dropped await on "${argStr.slice(0, 30)}"`,
          sourceHash,
        });
      }
    },

    // 5. const-perturb: Numeric literals and Boolean literals (excluding property keys)
    Literal(node: any, ancestors: any[]) {
      const parent = ancestors[ancestors.length - 2];
      if (parent && parent.type === "Property" && parent.key === node && !parent.computed) {
        return;
      }

      let mutatedVal: string | null = null;
      let desc = "";

      if (typeof node.value === "number") {
        const n = node.value;
        if (n === 0 || n === 1) return; // Skip 0 and 1 per R5.1/R10.1 specification
        const newN = n + 1;
        mutatedVal = String(newN);
        desc = `perturbed numeric constant from ${n} to ${newN}`;
      } else if (typeof node.value === "boolean") {
        mutatedVal = String(!node.value);
        desc = `perturbed boolean constant from ${node.value} to ${!node.value}`;
      }

      if (mutatedVal !== null) {
        const start = node.start - WRAPPER_OFFSET;
        const end = node.end - WRAPPER_OFFSET;
        const mutated = replaceSlice(source, start, end, mutatedVal);

        if (isValidSyntax(mutated)) {
          const idx = kindCounters["const-perturb"]++;
          mutations.push({
            id: `${cellId}:const-perturb:${idx}`,
            kind: "const-perturb",
            stratum: "value-level",
            notebookId,
            notebookName,
            cellId,
            originalSource: source,
            mutatedSource: mutated,
            description: desc,
            sourceHash,
          });
        }
      }
    },

    // 6. index-shift: computed member expression arr[i] -> arr[i + 1] or arr[0] -> arr[1]
    MemberExpression(node: any) {
      if (!node.computed || !node.property) return;
      const prop = node.property;
      let mutatedProp: string | null = null;
      let desc = "";

      if (prop.type === "Identifier") {
        mutatedProp = `${prop.name} + 1`;
        desc = `shifted index from "${prop.name}" to "${prop.name} + 1"`;
      } else if (prop.type === "Literal" && typeof prop.value === "number") {
        mutatedProp = String(prop.value + 1);
        desc = `shifted index from "${prop.value}" to "${prop.value + 1}"`;
      }

      if (mutatedProp !== null) {
        const start = prop.start - WRAPPER_OFFSET;
        const end = prop.end - WRAPPER_OFFSET;
        const mutated = replaceSlice(source, start, end, mutatedProp);

        if (isValidSyntax(mutated)) {
          const idx = kindCounters["index-shift"]++;
          mutations.push({
            id: `${cellId}:index-shift:${idx}`,
            kind: "index-shift",
            stratum: "value-level",
            notebookId,
            notebookName,
            cellId,
            originalSource: source,
            mutatedSource: mutated,
            description: desc,
            sourceHash,
          });
        }
      }
    },
  });

  return mutations;
}

/**
 * Appends a verified Mutation record to the mutations JSONL file.
 */
export function appendMutation(path: string, mutation: Mutation): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(mutation) + "\n", "utf8");
}

/**
 * Loads deterministic notebookId:cellId keys from results/determinism.jsonl.
 */
export function loadDeterministicCells(
  determinismPath = "./results/determinism.jsonl"
): Set<string> {
  const deterministicSet = new Set<string>();
  try {
    const lines = readFileSync(determinismPath, "utf8").trim().split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const v = JSON.parse(line);
      if (v.deterministic === true) {
        deterministicSet.add(`${v.notebookId}:${v.cellId}`);
      }
    }
  } catch {
    // If determinism file is missing, empty set
  }
  return deterministicSet;
}
