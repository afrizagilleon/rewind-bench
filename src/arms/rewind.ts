/**
 * Arm C — Rewind (R6 & R6.1 & R9)
 *
 * Interactive multi-turn debugging empowered with Materialized Scope Replay.
 * Receives terminal cell symptom (final expected vs actual output) and all cell sources upfront.
 * Reading a cell returns both cell source code and the exact recorded upstream scope
 * from the baseline run (scopeBefore).
 * Running a cell automatically injects the materialized scope if input is not provided.
 * Large values (>2000 chars per variable) are truncated with a clear marker.
 */

import { runAgentLoop, type AgentTools } from "../agent";
import type { ArmContext, ArmResult } from "./types";
import { hashValue } from "../ledger";
import { scopeBefore } from "../msr";
import { hopBandForDistance, stratumForKind } from "../mutate";

function formatTerminalSymptom(baselineRun: any, actualRun: any, terminalCellId: string): string {
  const expectedResult = baselineRun.cell_results?.[terminalCellId];
  const expectedOutput = expectedResult?.output !== undefined
    ? expectedResult.output
    : (baselineRun.outputs || null);

  const actualResult = actualRun.cell_results?.[terminalCellId];
  let actualOutput: any;
  if (actualResult) {
    actualOutput = actualResult.output !== undefined
      ? actualResult.output
      : (actualResult.error ? { error: actualResult.error } : null);
  } else if (actualRun.status === "failed") {
    actualOutput = { error: actualRun.error || "Notebook execution failed before completing" };
  } else {
    actualOutput = actualRun.outputs || null;
  }

  let symptom = `Expected notebook final output (from terminal cell before the bug):\n\`\`\`json\n${JSON.stringify(expectedOutput, null, 2)}\n\`\`\`\n\n`;
  symptom += `Actual notebook final output (current faulty state):\nStatus: ${actualRun.status}\n`;
  if (actualRun.error) {
    symptom += `Run error: ${actualRun.error}\n`;
  }
  if (actualRun.errors && Array.isArray(actualRun.errors) && actualRun.errors.length > 0) {
    symptom += `Errors: ${JSON.stringify(actualRun.errors, null, 2)}\n`;
  }
  symptom += `Output:\n\`\`\`json\n${JSON.stringify(actualOutput, null, 2)}\n\`\`\``;
  return symptom;
}

function formatAllCells(steps: any[]): string {
  const parts: string[] = [];
  function walk(s?: any[]) {
    for (const step of s ?? []) {
      if (step.kind === "parallel") {
        for (const lane of step.lanes ?? []) walk(lane.steps);
        continue;
      }
      const code = step.code ?? "";
      if (code.trim().length > 0) {
        parts.push(`--- Cell ID: ${step.id} ---\n\`\`\`javascript\n${code}\n\`\`\``);
      }
    }
  }
  walk(steps);
  return parts.join("\n\n");
}

function updateCellSourceInDoc(steps: any[], targetCellId: string, newSource: string): boolean {
  if (!Array.isArray(steps)) return false;
  for (const step of steps) {
    if (step.kind === "parallel" && Array.isArray(step.lanes)) {
      for (const lane of step.lanes) {
        if (updateCellSourceInDoc(lane.steps ?? [], targetCellId, newSource)) {
          return true;
        }
      }
      continue;
    }
    if (step.id === targetCellId) {
      step.code = newSource;
      return true;
    }
  }
  return false;
}

function findCellCode(steps: any[], targetCellId: string): string | null {
  if (!Array.isArray(steps)) return null;
  for (const step of steps) {
    if (step.kind === "parallel" && Array.isArray(step.lanes)) {
      for (const lane of step.lanes) {
        const found = findCellCode(lane.steps ?? [], targetCellId);
        if (found !== null) return found;
      }
      continue;
    }
    if (step.id === targetCellId) {
      return step.code ?? "";
    }
  }
  return null;
}

function formatScopeWithTruncation(
  scope: Record<string, unknown>,
  maxCharsPerVar = 2000
): { formatted: string; truncated: boolean } {
  let truncated = false;
  const processed: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(scope)) {
    const json = JSON.stringify(v);
    if (json.length > maxCharsPerVar) {
      truncated = true;
      processed[k] = `[truncated at ${maxCharsPerVar} chars]: ${json.slice(0, maxCharsPerVar)}...`;
    } else {
      processed[k] = v;
    }
  }

  return {
    formatted: JSON.stringify(processed, null, 2),
    truncated,
  };
}

export async function runRewindArm(ctx: ArmContext): Promise<ArmResult & { messages: any[] }> {
  const { mutation, scratchNotebookDoc, originalDoc, baselineRun, actualRun, terminalCellId, saveScratchDoc, runScratchCell, model, maxTokens, maxTurns } = ctx;

  const systemPrompt = `You are an automated code repair agent for zaatool reactive notebooks with Materialized Scope Replay.
A notebook previously produced correct outputs but now fails or produces incorrect final outputs.
You are given the symptom (expected vs actual final output) and the entire notebook source upfront.
When you read a cell using notebook_read, the recorded upstream state (scopeBefore) from the last good run is provided.
When you execute a cell using notebook_run_cell without input, that exact recorded upstream scope is automatically supplied.

Available actions (respond with exactly one JSON block):
1. Read cell code & recorded upstream state:
\`\`\`json
{"action": "notebook_read", "cell": "<cell_id>"}
\`\`\`
2. Run cell (upstream scope auto-injected if input is omitted):
\`\`\`json
{"action": "notebook_run_cell", "cell": "<cell_id>"}
\`\`\`
3. Edit cell code:
\`\`\`json
{"action": "notebook_edit_cell", "cell": "<cell_id>", "code": "<new_code>"}
\`\`\`
4. Finish when repaired:
\`\`\`json
{"action": "finish", "reason": "<description_of_fix>"}
\`\`\``;

  const initialUserMessage = `Notebook: "${mutation.notebookName}" (${mutation.notebookId})

=== SYMPTOM ===
${formatTerminalSymptom(baselineRun, actualRun, terminalCellId)}

=== NOTEBOOK SOURCE CELLS ===
${formatAllCells(scratchNotebookDoc.steps)}

Investigate the cells and their upstream state, locate the bug, repair it with notebook_edit_cell, and finish.`;

  let anyScopeTruncated = false;

  const tools: AgentTools = {
    rejectRun: false,
    readCell: async (cellId: string) => {
      const code = findCellCode(scratchNotebookDoc.steps, cellId);
      if (code === null) return { content: `Error: Cell "${cellId}" not found.` };

      const scopeResult = scopeBefore(originalDoc, baselineRun, cellId);
      const { formatted, truncated } = formatScopeWithTruncation(scopeResult.scope);
      if (truncated) anyScopeTruncated = true;

      return {
        content: `Cell ${cellId} source:\n\`\`\`javascript\n${code}\n\`\`\`\n\nUpstream state at this cell (recorded from the last good run):\n\`\`\`json\n${formatted}\n\`\`\``,
        scopeTruncated: truncated,
      };
    },
    runCell: async (cellId: string, input?: Record<string, unknown>) => {
      let finalInput = input;
      if (!finalInput || Object.keys(finalInput).length === 0) {
        const scopeResult = scopeBefore(originalDoc, baselineRun, cellId);
        finalInput = scopeResult.scope;
      }
      return await runScratchCell(cellId, finalInput);
    },
    editCell: async (cellId: string, code: string) => {
      const updated = updateCellSourceInDoc(scratchNotebookDoc.steps, cellId, code);
      if (!updated) return { success: false, error: `Cell "${cellId}" not found in notebook.` };
      await saveScratchDoc(scratchNotebookDoc);
      return { success: true };
    },
  };

  const summary = await runAgentLoop(systemPrompt, initialUserMessage, tools, {
    model,
    maxTokens,
    temperature: 0,
    seed: 42,
    reasoningEffort: "low",
    maxTurns: maxTurns || 15,
  });

  // Evaluate resolution against baseline scope
  const targetScope = scopeBefore(originalDoc, baselineRun, mutation.cellId);
  const finalRun = await runScratchCell(mutation.cellId, targetScope.scope);
  let resolved = false;
  if (!finalRun.error && finalRun.output !== undefined) {
    const finalHash = hashValue(finalRun.output);
    resolved = finalHash === mutation.baselineHash;
  }
  const luckyPass = resolved && !summary.editedCells.includes(mutation.cellId);
  const hopDistance = mutation.hopDistance ?? 1;
  const hopBand = mutation.hopBand ?? hopBandForDistance(hopDistance);
  const stratum = mutation.stratum ?? stratumForKind(mutation.kind);

  return {
    arm: "rewind",
    mutationId: mutation.id,
    stratum,
    hopDistance,
    hopBand,
    model: model || process.env.MODEL_PRIMARY || "deepseek-ai/DeepSeek-V4-Flash-0731",
    editedCells: summary.editedCells,
    turns: summary.turns,
    wallMs: summary.wallMs,
    promptTokens: summary.promptTokens,
    reasoningTokens: summary.reasoningTokens,
    answerTokens: summary.answerTokens,
    totalTokens: summary.totalTokens,
    resolved,
    luckyPass,
    protocolFailure: summary.protocolFailure,
    lengthFailure: summary.lengthFailure,
    scopeTruncated: anyScopeTruncated || summary.scopeTruncated,
    stopReason: summary.stopReason,
    messages: summary.messages,
  };
}
