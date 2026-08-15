/**
 * Arm A — Monolithic (R6 & R6.1 & R9)
 *
 * One-shot whole-notebook repair without execution tools.
 * Receives terminal cell symptom (final expected vs actual output) and all cell sources upfront.
 * Rejects notebook_run_cell actions.
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

export async function runMonolithicArm(ctx: ArmContext): Promise<ArmResult & { messages: any[] }> {
  const { mutation, scratchNotebookDoc, originalDoc, baselineRun, actualRun, terminalCellId, saveScratchDoc, runScratchCell, model, maxTokens, maxTurns } = ctx;

  const systemPrompt = `You are an automated code repair agent for zaatool reactive notebooks.
A notebook previously produced correct outputs but now fails or produces incorrect final outputs.
You are given the symptom (expected vs actual final output) and the entire notebook source.
You must trace the dataflow, locate the faulty cell, repair it using the notebook_edit_cell action, and call finish.
Note: notebook_run_cell is DISABLED in monolithic mode.

Respond ONLY with a fenced JSON code block:
\`\`\`json
{"action": "notebook_edit_cell", "cell": "<cell_id>", "code": "<repaired_code>"}
\`\`\`
or
\`\`\`json
{"action": "finish", "reason": "<description_of_fix>"}
\`\`\``;

  const initialUserMessage = `Notebook: "${mutation.notebookName}" (${mutation.notebookId})

=== SYMPTOM ===
${formatTerminalSymptom(baselineRun, actualRun, terminalCellId)}

=== NOTEBOOK SOURCE CELLS ===
${formatAllCells(scratchNotebookDoc.steps)}

Locate the bug causing the final output discrepancy, fix it using notebook_edit_cell, and finish.`;

  const tools: AgentTools = {
    rejectRun: true,
    readCell: async (cellId: string) => {
      const code = findCellCode(scratchNotebookDoc.steps, cellId);
      if (code === null) return { content: `Error: Cell "${cellId}" not found.` };
      return { content: `Cell ${cellId} code:\n\`\`\`javascript\n${code}\n\`\`\`` };
    },
    runCell: async () => {
      return { error: "notebook_run_cell is not available in monolithic mode" };
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
    arm: "monolithic",
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
    scopeTruncated: summary.scopeTruncated,
    stopReason: summary.stopReason,
    messages: summary.messages,
  };
}
