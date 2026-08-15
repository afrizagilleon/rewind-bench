/**
 * Arm Types & Definitions (R6 & R6.1)
 */

import type { Mutation } from "../mutate";

export type StopReason = "finished" | "max-turns" | "protocol" | "length";

export interface ArmResult {
  arm: "monolithic" | "stepwise" | "rewind";
  mutationId: string;
  model: string;

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
}

export interface ArmContext {
  mutation: Mutation;
  scratchNotebookDoc: any;
  originalDoc: any;
  baselineRun: any;
  actualRun: any; // Run outcome of mutated scratch notebook before agent repair
  saveScratchDoc: (doc: any) => Promise<void>;
  runScratchCell: (cellId: string, input?: Record<string, unknown>) => Promise<{ output?: unknown; error?: string }>;
  model?: string;
  maxTokens?: number;
  maxTurns?: number;
}
