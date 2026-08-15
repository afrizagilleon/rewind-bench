/**
 * Core Agent Loop (R6 & R6.1)
 *
 * Single shared agent loop (~150 lines) used by Monolithic, Stepwise, and Rewind arms.
 * Enforces structured JSON protocol over Featherless OpenAI-compatible chat completions.
 * Handles turns (up to maxTurns=15), corrections (max 2), token accounting,
 * and length failure detection without silent retries.
 */

import { requireEnv } from "./client";
import type { StopReason } from "./arms/types";

export interface AgentAction {
  action: "notebook_read" | "notebook_run_cell" | "notebook_edit_cell" | "finish";
  cell?: string;
  code?: string;
  input?: Record<string, unknown>;
  reason?: string;
  [key: string]: unknown;
}

export interface AgentTools {
  readCell: (cellId: string) => Promise<{ content: string; scopeTruncated?: boolean }>;
  runCell: (cellId: string, input?: Record<string, unknown>) => Promise<{ output?: unknown; error?: string }>;
  editCell: (cellId: string, code: string) => Promise<{ success: boolean; error?: string }>;
  rejectRun?: boolean; // If true (Arm A), rejects notebook_run_cell
}

export interface AgentConfig {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  seed?: number;
  reasoningEffort?: string;
  maxTurns?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AgentRunSummary {
  editedCells: string[];
  turns: number;
  wallMs: number;
  promptTokens: number;
  reasoningTokens: number;
  answerTokens: number;
  totalTokens: number;
  resolved: boolean;
  luckyPass: boolean;
  protocolFailure: boolean;
  lengthFailure: boolean;
  scopeTruncated: boolean;
  stopReason: StopReason;
  finishReason?: string;
  messages: ChatMessage[];
}

/**
 * Extracts and parses a fenced JSON action block from model output.
 */
export function parseModelAction(raw: string): AgentAction | null {
  if (!raw || typeof raw !== "string") return null;

  // 1. Try matching fenced block ```json ... ``` or ``` ... ```
  const fencedMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(raw);
  const jsonString = fencedMatch ? fencedMatch[1].trim() : raw.trim();

  try {
    const parsed = JSON.parse(jsonString);
    if (parsed && typeof parsed === "object" && typeof parsed.action === "string") {
      return parsed as AgentAction;
    }
  } catch {
    // Try finding first { and matching last }
    const firstBrace = jsonString.indexOf("{");
    const lastBrace = jsonString.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        const candidate = JSON.parse(jsonString.slice(firstBrace, lastBrace + 1));
        if (candidate && typeof candidate === "object" && typeof candidate.action === "string") {
          return candidate as AgentAction;
        }
      } catch {
        // failed
      }
    }
  }

  return null;
}

/**
 * Runs the agent loop for a given task until finish, maxTurns, or protocol failure.
 */
export async function runAgentLoop(
  systemPrompt: string,
  initialUserMessage: string,
  tools: AgentTools,
  config: AgentConfig = {}
): Promise<AgentRunSummary> {
  const startTime = Date.now();

  const apiKey = requireEnv("FEATHERLESS_API_KEY");
  const baseUrl = (process.env.FEATHERLESS_BASE_URL?.trim() || "https://api.featherless.ai/v1").replace(/\/+$/, "");
  const model = config.model || process.env.MODEL_PRIMARY || "deepseek-ai/DeepSeek-V4-Flash-0731";
  const maxTokens = config.maxTokens || parseInt(process.env.ARM_MAX_TOKENS || "16000", 10);
  const temperature = config.temperature ?? 0;
  const seed = config.seed ?? 42;
  const reasoningEffort = config.reasoningEffort || "low";
  const maxTurns = config.maxTurns || 15;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Turn 1 of ${maxTurns}.\n\n${initialUserMessage}` },
  ];

  const editedCells: string[] = [];
  let promptTokens = 0;
  let reasoningTokens = 0;
  let answerTokens = 0;
  let totalTokens = 0;
  let protocolFailure = false;
  let lengthFailure = false;
  let scopeTruncated = false;
  let finishReason = "";
  let stopReason: StopReason = "max-turns";
  let protocolErrorCount = 0;
  let turns = 0;

  for (let turn = 1; turn <= maxTurns; turn++) {
    turns = turn;

    const reqBody = {
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      seed,
      reasoning_effort: reasoningEffort,
    };

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(reqBody),
      });
    } catch (err: unknown) {
      protocolFailure = true;
      stopReason = "protocol";
      break;
    }

    if (!res.ok) {
      protocolFailure = true;
      stopReason = "protocol";
      break;
    }

    const data = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string; reasoning?: string };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };

    const choice = data.choices?.[0];
    const content = choice?.message?.content || "";
    const reasoning = choice?.message?.reasoning || "";
    const fReason = choice?.finish_reason || "";

    // Track tokens
    const pTokens = data.usage?.prompt_tokens || 0;
    const cTokens = data.usage?.completion_tokens || 0;
    const tTokens = data.usage?.total_tokens || (pTokens + cTokens);

    let rTokens = data.usage?.completion_tokens_details?.reasoning_tokens;
    if (rTokens === undefined) {
      rTokens = reasoning.length > 0 ? Math.min(cTokens, Math.max(1, Math.round(reasoning.length / 3.8))) : 0;
    }
    const aTokens = Math.max(0, cTokens - rTokens);

    promptTokens += pTokens;
    reasoningTokens += rTokens;
    answerTokens += aTokens;
    totalTokens += tTokens;

    if (fReason === "length") {
      lengthFailure = true;
      stopReason = "length";
    }

    messages.push({ role: "assistant", content });

    // Parse model's structured action
    const action = parseModelAction(content);
    if (!action) {
      protocolErrorCount++;
      if (protocolErrorCount > 2) {
        protocolFailure = true;
        stopReason = "protocol";
        break;
      }
      messages.push({
        role: "user",
        content: `Turn ${turn + 1} of ${maxTurns}.\nInvalid format. You must respond with EXACTLY ONE fenced JSON code block:\n\`\`\`json\n{"action": "..."}\n\`\`\``,
      });
      continue;
    }

    // Process action
    if (action.action === "finish") {
      finishReason = String(action.reason || "completed");
      stopReason = "finished";
      break;
    }

    const nextTurnHeader = turn < maxTurns ? `Turn ${turn + 1} of ${maxTurns}.\n\n` : "";

    if (action.action === "notebook_read") {
      const cellId = String(action.cell || "");
      if (!cellId) {
        messages.push({ role: "user", content: `${nextTurnHeader}Error: missing 'cell' parameter in notebook_read` });
        continue;
      }
      const readResult = await tools.readCell(cellId);
      if (readResult.scopeTruncated) scopeTruncated = true;
      messages.push({ role: "user", content: `${nextTurnHeader}${readResult.content}` });
      continue;
    }

    if (action.action === "notebook_run_cell") {
      if (tools.rejectRun) {
        messages.push({
          role: "user",
          content: `${nextTurnHeader}Error: notebook_run_cell is not available in monolithic mode. You must edit the code directly and finish.`,
        });
        continue;
      }
      const cellId = String(action.cell || "");
      if (!cellId) {
        messages.push({ role: "user", content: `${nextTurnHeader}Error: missing 'cell' parameter in notebook_run_cell` });
        continue;
      }
      const runRes = await tools.runCell(cellId, action.input);
      const resText = runRes.error
        ? `Cell execution failed:\n${runRes.error}`
        : `Cell output:\n${JSON.stringify(runRes.output, null, 2)}`;
      messages.push({ role: "user", content: `${nextTurnHeader}${resText}` });
      continue;
    }

    if (action.action === "notebook_edit_cell") {
      const cellId = String(action.cell || "");
      const code = String(action.code || "");
      if (!cellId || code === undefined) {
        messages.push({ role: "user", content: `${nextTurnHeader}Error: missing 'cell' or 'code' in notebook_edit_cell` });
        continue;
      }
      const editRes = await tools.editCell(cellId, code);
      if (editRes.success) {
        if (!editedCells.includes(cellId)) {
          editedCells.push(cellId);
        }
        messages.push({ role: "user", content: `${nextTurnHeader}Cell ${cellId} updated successfully.` });
      } else {
        messages.push({ role: "user", content: `${nextTurnHeader}Failed to update cell ${cellId}: ${editRes.error}` });
      }
      continue;
    }

    // Unknown action
    protocolErrorCount++;
    if (protocolErrorCount > 2) {
      protocolFailure = true;
      stopReason = "protocol";
      break;
    }
    messages.push({
      role: "user",
      content: `${nextTurnHeader}Unknown action "${action.action}". Allowed actions: notebook_read, notebook_run_cell, notebook_edit_cell, finish.`,
    });
  }

  const wallMs = Date.now() - startTime;

  return {
    editedCells,
    turns,
    wallMs,
    promptTokens,
    reasoningTokens,
    answerTokens,
    totalTokens,
    resolved: false,
    luckyPass: false,
    protocolFailure,
    lengthFailure,
    scopeTruncated,
    stopReason,
    finishReason,
    messages,
  };
}
