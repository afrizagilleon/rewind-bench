/**
 * Arm Types & Definitions (R6)
 */

import type { Mutation } from "../mutate";

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
}

export interface ArmContext {
  mutation: Mutation;
  scratchNotebookDoc: any;
  originalDoc: any;
  baselineRun: any;
  saveScratchDoc: (doc: any) => Promise<void>;
  runScratchCell: (cellId: string, input?: Record<string, unknown>) => Promise<{ output?: unknown; error?: string }>;
  model?: string;
  maxTokens?: number;
}
