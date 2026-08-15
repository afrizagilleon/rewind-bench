/**
 * Arm B — Stepwise (R6)
 *
 * Interactive multi-turn debugging.
 * Agent can inspect cell source via notebook_read and run cells via notebook_run_cell,
 * but must construct the input scope manually (starts from empty scope if not provided).
 */

import { runAgentLoop, type AgentTools } from "../agent";
import type { ArmContext, ArmResult } from "./types";
import { hashValue } from "../ledger";
import { scopeBefore } from "../msr";

function formatCellOutline(steps: any[]): string {
  const parts: string[] = [];
  function walk(s?: any[]) {
    for (const step of s ?? []) {
      if (step.kind === "parallel") {
        for (const lane of step.lanes ?? []) walk(lane.steps);
        continue;
      }
      const code = step.code ?? "";
      if (code.trim().length > 0) {
        parts.push(`- Cell ID: ${step.id}`);
      }
    }
  }
  walk(steps);
  return parts.join("\n");
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

export async function runStepwiseArm(ctx: ArmContext): Promise<ArmResult> {
  const { mutation, scratchNotebookDoc, originalDoc, baselineRun, saveScratchDoc, runScratchCell, model, maxTokens } = ctx;

  const systemPrompt = `You are an automated code repair agent for zaatool reactive notebooks.
A notebook previously produced correct outputs but now fails or produces incorrect results.
You can read cell sources, execute individual cells with custom inputs, and repair faulty cells.

Available actions (respond with exactly one JSON block):
1. Read cell code:
\`\`\`json
{"action": "notebook_read", "cell": "<cell_id>"}
\`\`\`
2. Run cell with manual input:
\`\`\`json
{"action": "notebook_run_cell", "cell": "<cell_id>", "input": {"varName": "value"}}
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
The notebook has stopped producing expected results.
Here are the cells in this notebook:
${formatCellOutline(scratchNotebookDoc.steps)}

Investigate the cells, diagnose the failure, fix the bug with notebook_edit_cell, and finish.`;

  const tools: AgentTools = {
    rejectRun: false,
    readCell: async (cellId: string) => {
      const code = findCellCode(scratchNotebookDoc.steps, cellId);
      if (code === null) return { content: `Error: Cell "${cellId}" not found.` };
      return { content: `Cell ${cellId} source:\n\`\`\`javascript\n${code}\n\`\`\`` };
    },
    runCell: async (cellId: string, input?: Record<string, unknown>) => {
      return await runScratchCell(cellId, input || {});
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
    maxTurns: 8,
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

  return {
    arm: "stepwise",
    mutationId: mutation.id,
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
  };
}
