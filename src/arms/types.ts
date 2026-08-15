/**
 * Arm Types & Definitions (R6 & R6.1 & R5.1 & R9)
 */

import type { Mutation, Stratum, HopBand, DistBand } from "../mutate";

export type StopReason = "finished" | "max-turns" | "protocol" | "length";

export interface ArmResult {
  arm: "monolithic" | "stepwise" | "rewind";
  mutationId: string;
  stratum: Stratum;
  hopDistance: number;
  hopBand: HopBand;
  distanceToTerminal: number;
  distBand: DistBand;
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
  actualRun: any;
  terminalCellId: string;
  saveScratchDoc: (doc: any) => Promise<void>;
  runScratchCell: (cellId: string, input?: Record<string, unknown>) => Promise<{ output?: unknown; error?: string }>;
  model?: string;
  maxTokens?: number;
  maxTurns?: number;
}
