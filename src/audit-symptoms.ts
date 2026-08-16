/**
 * RewindBench — Symptom Visibility Audit (R11.1)
 *
 * Audits whether each mutation in the designed and incidental corpora produces
 * a detectable output change specifically on the TERMINAL cell of the notebook.
 *
 * Grounding:
 *   R9 defined symptom as the terminal cell's output (expected vs actual),
 *   while mutation validation and full resolution were scored on whole-run hashes.
 *   This audit quantifies how many mutations produced visible terminal symptoms.
 *
 * Output:
 *   results/symptom-audit.json
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  getNotebook,
  runNotebook,
  requireEnv,
  type RunDetail,
} from "./client";
import { hashValue } from "./ledger";
import type { Mutation } from "./mutate";

interface MutationAuditRecord {
  corpus: "designed" | "incidental";
  mutationId: string;
  notebookId: string;
  notebookName: string;
  cellId: string;
  kind: string;
  stratum: string;
  distanceToTerminal: number;
  distBand: string;
  hopDistance: number;
  hopBand: string;
  baselineTerminalHash: string;
  mutantTerminalHash: string;
  symptomVisible: boolean;
  baselineTerminalOutput?: unknown;
  mutantTerminalOutput?: unknown;
}

interface CorpusAuditSummary {
  total: number;
  symptomVisible: number;
  symptomInvisible: number;
  visibleRate: number;
  byDistBand: {
    direct: { total: number; visible: number; invisible: number };
    short: { total: number; visible: number; invisible: number };
    long: { total: number; visible: number; invisible: number };
    unknown?: { total: number; visible: number; invisible: number };
  };
  byStratum: {
    "value-level": { total: number; visible: number; invisible: number };
    "name-level": { total: number; visible: number; invisible: number };
  };
}

interface AuditReport {
  timestamp: string;
  summary: {
    designed: CorpusAuditSummary;
    incidental: CorpusAuditSummary;
  };
  details: MutationAuditRecord[];
}

let cachedSessionToken: string | null = null;

function getAuthHeaders(): Record<string, string> {
  const token = cachedSessionToken || process.env.ZAA_SESSION_TOKEN?.trim() || requireEnv("ZAA_SESSION_TOKEN");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function apiRequest(path: string, options: RequestInit = {}, isRetry = false): Promise<Response> {
  const baseUrl = (process.env.ZAA_BASE_URL?.trim() || "http://localhost:4000").replace(/\/+$/, "");
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      ...getAuthHeaders(),
      ...(options.headers as Record<string, string> | undefined),
    },
  });

  if (res.status === 401 && !isRetry) {
    const username = process.env.ZAA_USERNAME?.trim();
    const password = process.env.ZAA_PASSWORD?.trim();
    if (username && password) {
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (loginRes.ok) {
        const loginData = (await loginRes.json()) as { token?: string };
        if (loginData.token) {
          cachedSessionToken = loginData.token;
          return await apiRequest(path, options, true);
        }
      }
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }

  return res;
}

async function saveNotebookDoc(doc: any): Promise<any> {
  const res = await apiRequest(`/api/notebooks`, {
    method: "POST",
    body: JSON.stringify(doc),
  });
  return await res.json();
}

async function deleteNotebook(notebookId: string, name?: string): Promise<void> {
  if (name && !name.startsWith("zz-rewind-") && !name.endsWith("-copy")) {
    console.error(`Safety refusal: refusing to delete non-scratch notebook "${name}" (${notebookId})`);
    return;
  }
  const res = await apiRequest(`/api/notebooks/${encodeURIComponent(notebookId)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    console.error(`Failed to delete notebook ${notebookId}: HTTP ${res.status}`);
  }
}

function getTerminalCellId(steps: any[]): string {
  let lastCellId = "";
  function walk(s?: any[]) {
    for (const step of s ?? []) {
      if (step.kind === "parallel") {
        for (const lane of step.lanes ?? []) walk(lane.steps);
        continue;
      }
      const code = step.code ?? "";
      if (code.trim().length > 0) {
        lastCellId = step.id;
      }
    }
  }
  walk(steps);
  return lastCellId;
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

function readJsonl(path: string): any[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const result: any[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      try {
        result.push(JSON.parse(trimmed));
      } catch {
        // ignore
      }
    }
  }
  return result;
}

function buildEmptySummary(): CorpusAuditSummary {
  return {
    total: 0,
    symptomVisible: 0,
    symptomInvisible: 0,
    visibleRate: 0,
    byDistBand: {
      direct: { total: 0, visible: 0, invisible: 0 },
      short: { total: 0, visible: 0, invisible: 0 },
      long: { total: 0, visible: 0, invisible: 0 },
      unknown: { total: 0, visible: 0, invisible: 0 },
    },
    byStratum: {
      "value-level": { total: 0, visible: 0, invisible: 0 },
      "name-level": { total: 0, visible: 0, invisible: 0 },
    },
  };
}

function updateSummary(summary: CorpusAuditSummary, record: MutationAuditRecord) {
  summary.total++;
  if (record.symptomVisible) {
    summary.symptomVisible++;
  } else {
    summary.symptomInvisible++;
  }
  summary.visibleRate = summary.total > 0 ? summary.symptomVisible / summary.total : 0;

  // by distBand
  const dBand = (record.distBand || "unknown") as "direct" | "short" | "long" | "unknown";
  if (!summary.byDistBand[dBand]) {
    summary.byDistBand[dBand] = { total: 0, visible: 0, invisible: 0 };
  }
  summary.byDistBand[dBand].total++;
  if (record.symptomVisible) summary.byDistBand[dBand].visible++;
  else summary.byDistBand[dBand].invisible++;

  // by stratum
  const stratum = (record.stratum || "value-level") as "value-level" | "name-level";
  if (summary.byStratum[stratum]) {
    summary.byStratum[stratum].total++;
    if (record.symptomVisible) summary.byStratum[stratum].visible++;
    else summary.byStratum[stratum].invisible++;
  }
}

export async function auditSymptoms(): Promise<AuditReport> {
  const designedMutationsPath = join(process.cwd(), "results", "mutations-designed.jsonl");
  const incidentalMutationsPath = join(process.cwd(), "results", "mutations.jsonl");

  const designedMutations: Mutation[] = readJsonl(designedMutationsPath);
  const incidentalMutations: Mutation[] = readJsonl(incidentalMutationsPath);

  console.log("================================================================================");
  console.log("  RewindBench — Symptom Visibility Audit (R11.1)");
  console.log("================================================================================");
  console.log(`Corpus Terancang   : ${designedMutations.length} mutasi`);
  console.log(`Corpus Insidental  : ${incidentalMutations.length} mutasi`);
  console.log("Memulai eksekusi offline baseline vs mutant hashes...\n");

  const notebookCache: Record<string, { originalDoc: any; baselineRun: RunDetail; terminalCellId: string; baselineTerminalHash: string }> = {};

  async function getCachedNotebookBaseline(notebookId: string, notebookName: string) {
    if (notebookCache[notebookId]) {
      return notebookCache[notebookId];
    }

    // Try fixture for designed
    let originalDoc: any = null;
    const fixturePath = join(process.cwd(), "fixtures", "designed", `${notebookName}.json`);
    if (existsSync(fixturePath)) {
      originalDoc = JSON.parse(readFileSync(fixturePath, "utf8"));
    } else {
      originalDoc = (await getNotebook(notebookId)) as any;
    }

    const terminalCellId = getTerminalCellId(originalDoc.steps);

    // Run baseline in scratch notebook
    const scratchDoc = {
      name: `zz-rewind-audit-base-${randomUUID().slice(0, 8)}`,
      runtime: originalDoc.runtime || "javascript",
      steps: JSON.parse(JSON.stringify(originalDoc.steps)),
    };
    const saved = await saveNotebookDoc(scratchDoc);
    let baselineRun: RunDetail;
    try {
      baselineRun = await runNotebook(saved.id);
    } finally {
      await deleteNotebook(saved.id, saved.name);
    }

    const terminalResult = baselineRun.cell_results?.[terminalCellId];
    const terminalOutput = terminalResult?.output !== undefined
      ? terminalResult.output
      : (baselineRun.status === "failed" ? { error: (baselineRun as any).error } : (baselineRun as any).outputs || null);

    const baselineTerminalHash = hashValue(terminalOutput);

    const cached = { originalDoc, baselineRun, terminalCellId, baselineTerminalHash };
    notebookCache[notebookId] = cached;
    return cached;
  }

  const details: MutationAuditRecord[] = [];
  const designedSummary = buildEmptySummary();
  const incidentalSummary = buildEmptySummary();

  const allItems: Array<{ corpus: "designed" | "incidental"; mutation: Mutation }> = [
    ...designedMutations.map((m) => ({ corpus: "designed" as const, mutation: m })),
    ...incidentalMutations.map((m) => ({ corpus: "incidental" as const, mutation: m })),
  ];

  let processedCount = 0;

  for (const { corpus, mutation } of allItems) {
    processedCount++;
    const shortId = mutation.id.slice(0, 32);
    process.stdout.write(`[${String(processedCount).padStart(2, " ")}/${allItems.length}] [${corpus.padEnd(10, " ")}] ${shortId}... `);

    const cached = await getCachedNotebookBaseline(mutation.notebookId, mutation.notebookName);
    const { originalDoc, terminalCellId, baselineTerminalHash } = cached;

    // Create scratch doc for mutant
    const scratchDoc = {
      name: `zz-rewind-audit-mut-${randomUUID().slice(0, 8)}`,
      runtime: originalDoc.runtime || "javascript",
      steps: JSON.parse(JSON.stringify(originalDoc.steps)),
    };
    updateCellSourceInDoc(scratchDoc.steps, mutation.cellId, mutation.mutatedSource);

    const saved = await saveNotebookDoc(scratchDoc);
    let mutantRun: RunDetail;
    try {
      mutantRun = await runNotebook(saved.id);
    } finally {
      await deleteNotebook(saved.id, saved.name);
    }

    const mutantResult = mutantRun.cell_results?.[terminalCellId];
    const mutantOutput = mutantResult?.output !== undefined
      ? mutantResult.output
      : (mutantRun.status === "failed" ? { error: (mutantRun as any).error } : (mutantRun as any).outputs || null);

    const mutantTerminalHash = hashValue(mutantOutput);
    const symptomVisible = baselineTerminalHash !== mutantTerminalHash;

    const record: MutationAuditRecord = {
      corpus,
      mutationId: mutation.id,
      notebookId: mutation.notebookId,
      notebookName: mutation.notebookName,
      cellId: mutation.cellId,
      kind: mutation.kind,
      stratum: mutation.stratum || "value-level",
      distanceToTerminal: mutation.distanceToTerminal ?? 0,
      distBand: mutation.distBand || "unknown",
      hopDistance: mutation.hopDistance ?? 0,
      hopBand: mutation.hopBand || "unknown",
      baselineTerminalHash,
      mutantTerminalHash,
      symptomVisible,
    };

    details.push(record);

    if (corpus === "designed") {
      updateSummary(designedSummary, record);
    } else {
      updateSummary(incidentalSummary, record);
    }

    console.log(symptomVisible ? "VISIBLE ✓" : "INVISIBLE ✗");
  }

  const report: AuditReport = {
    timestamp: new Date().toISOString(),
    summary: {
      designed: designedSummary,
      incidental: incidentalSummary,
    },
    details,
  };

  const outputPath = join(process.cwd(), "results", "symptom-audit.json");
  writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");

  console.log("\n================================================================================");
  console.log("  HASIL AUDIT VISIBILITAS GEJALA TERMINAL (R11.1)");
  console.log("================================================================================");

  console.log(`\n1. CORPUS TERANCANG (DESIGNED) [N = ${designedSummary.total}]:`);
  console.log(`   - Gejala Terlihat (Visible)   : ${designedSummary.symptomVisible} / ${designedSummary.total} (${(designedSummary.visibleRate * 100).toFixed(1)}%)`);
  console.log(`   - Gejala Tak Terlihat (Hidden): ${designedSummary.symptomInvisible} / ${designedSummary.total} (${((1 - designedSummary.visibleRate) * 100).toFixed(1)}%)`);
  console.log(`   * by distBand:`);
  console.log(`     - direct (dist 0) : ${designedSummary.byDistBand.direct.visible}/${designedSummary.byDistBand.direct.total} visible`);
  console.log(`     - short  (dist 1-3): ${designedSummary.byDistBand.short.visible}/${designedSummary.byDistBand.short.total} visible`);
  console.log(`     - long   (dist 4+) : ${designedSummary.byDistBand.long.visible}/${designedSummary.byDistBand.long.total} visible`);

  console.log(`\n2. CORPUS INSIDENTAL (REAL-WORLD) [N = ${incidentalSummary.total}]:`);
  console.log(`   - Gejala Terlihat (Visible)   : ${incidentalSummary.symptomVisible} / ${incidentalSummary.total} (${(incidentalSummary.visibleRate * 100).toFixed(1)}%)`);
  console.log(`   - Gejala Tak Terlihat (Hidden): ${incidentalSummary.symptomInvisible} / ${incidentalSummary.total} (${((1 - incidentalSummary.visibleRate) * 100).toFixed(1)}%)`);
  console.log(`   * by distBand:`);
  console.log(`     - direct (dist 0) : ${incidentalSummary.byDistBand.direct.visible}/${incidentalSummary.byDistBand.direct.total} visible`);
  console.log(`     - short  (dist 1-3): ${incidentalSummary.byDistBand.short.visible}/${incidentalSummary.byDistBand.short.total} visible`);
  console.log(`     - long   (dist 4+) : ${incidentalSummary.byDistBand.long.visible}/${incidentalSummary.byDistBand.long.total} visible`);
  if (incidentalSummary.byDistBand.unknown?.total) {
    console.log(`     - unknown         : ${incidentalSummary.byDistBand.unknown.visible}/${incidentalSummary.byDistBand.unknown.total} visible`);
  }

  console.log("\n================================================================================");
  console.log(`Audit berhasil disimpan ke: ${outputPath}`);
  console.log("================================================================================\n");

  return report;
}

if (process.argv[1] && process.argv[1].includes("audit-symptoms")) {
  auditSymptoms().catch((err) => {
    console.error("Audit symptoms failed:", err);
    process.exit(1);
  });
}
