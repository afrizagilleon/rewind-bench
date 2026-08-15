/**
 * Mutation Engine (R5 / Ground Truth)
 *
 * Generates synthetic single-point bugs using acorn AST transformations across 5 kinds:
 * - off-by-one
 * - key-rename
 * - operand-swap
 * - dropped-await
 * - type-coercion
 *
 * Implements two-layer validation (syntax parsing and empirical behavioral deviation)
 * using temporary scratch notebooks (zz-rewind-scratch-*) to protect user data.
 */

import { parse } from "acorn";
import { ancestor as walkAncestor } from "acorn-walk";
import { hashSource } from "./ledger";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type MutationKind =
  | "off-by-one"
  | "key-rename"
  | "operand-swap"
  | "dropped-await"
  | "type-coercion";

export interface Mutation {
  id: string; // `${cellId}:${kind}:${index}`
  kind: MutationKind;
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
  };

  // Helper to check if node is inside a nested inner function
  function isInsideInnerFunction(ancestors: any[]): boolean {
    // ancestors[0] is Program, ancestors[1] is FunctionDeclaration (__cell)
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

    // 2. BinaryExpression: off-by-one (<, <=, >, >=) & operand-swap (-, /, %, <, >)
    BinaryExpression(node: any) {
      const op = node.operator;

      // 2a. off-by-one
      let newOp: string | null = null;
      if (op === "<") newOp = "<=";
      else if (op === "<=") newOp = "<";
      else if (op === ">") newOp = ">=";
      else if (op === ">=") newOp = ">";

      if (newOp) {
        const leftEnd = node.left.end - WRAPPER_OFFSET;
        const rightStart = node.right.start - WRAPPER_OFFSET;
        const opRegion = source.slice(leftEnd, rightStart);
        const opIndexInRegion = opRegion.indexOf(op);

        if (opIndexInRegion !== -1) {
          const opStart = leftEnd + opIndexInRegion;
          const opEnd = opStart + op.length;
          const mutated = replaceSlice(source, opStart, opEnd, newOp);

          if (isValidSyntax(mutated)) {
            const idx = kindCounters["off-by-one"]++;
            mutations.push({
              id: `${cellId}:off-by-one:${idx}`,
              kind: "off-by-one",
              notebookId,
              notebookName,
              cellId,
              originalSource: source,
              mutatedSource: mutated,
              description: `changed "${op}" to "${newOp}" in comparison`,
              sourceHash,
            });
          }
        }
      }

      // 2b. operand-swap
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

    // 3. CallExpression: off-by-one (slice/substring/splice) & type-coercion (Number/String/parseInt/parseFloat)
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
