/**
 * RewindBench — Interactive Video Demo Runner (R11)
 *
 * Demonstrates interactive debugging and held-out verification live on camera.
 * Uses a single PERSISTENT notebook named "rewind-demo" (rb-designed-risk-assessment).
 *
 * Commands:
 *   npm run demo -- --step=1   Restore to ground truth, execute, print final score
 *   npm run demo -- --step=2   Inject bug b143f174 (penalty *22 -> *23), execute, print faulty output
 *   npm run demo -- --step=3   Run Rewind Arm with 1.5s delay before edits (camera-friendly 1-line logs)
 *   npm run demo -- --step=4   Install held-out seed, execute, check truth hash, print LULUS / GAGAL
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  listNotebooks,
  getNotebook,
  runNotebook,
  runCell,
  requireEnv,
  type RunDetail,
} from "./client";
import { hashValue } from "./ledger";
import { scopeBefore } from "./msr";
import { parseModelAction, type AgentAction, type ChatMessage } from "./agent";

const DEMO_NOTEBOOK_NAME = "rewind-demo";
const FIXTURE_PATH = join(process.cwd(), "fixtures", "designed", "rb-designed-risk-assessment.json");
const HELDOUT_FIXTURE_PATH = join(process.cwd(), "fixtures", "designed", "rb-designed-risk-assessment.heldout.json");

const CELL_NAMES: Record<string, string> = {
  "8eb26c83-8077-4337-aa61-ed3350e0ad84": "applicants",
  "0423a307-7710-4b98-82bd-aae49a6caf6d": "dtiProfiles",
  "8aafc3f1-a894-4b76-b726-c4a7e605cb88": "ltvProfiles",
  "95afd5ff-4bdd-4d01-b76c-86a312f526f2": "capacityProfiles",
  "b143f174-8e7c-455e-984b-efff641fbf35": "historyScores",
  "9411fe51-6722-4596-9d4e-1c9f2c023bfe": "riskScores",
  "06af996f-ab97-4215-86c3-4600e53e987d": "portfolio",
};

const TERMINAL_CELL_ID = "06af996f-ab97-4215-86c3-4600e53e987d";
const MUTATED_CELL_ID = "b143f174-8e7c-455e-984b-efff641fbf35";

const BASELINE_SEED_CODE = `const applicants = [
  { id: 'APP-01', age: 34, monthlyIncome: 15000, monthlyDebt: 3500, creditHistoryYears: 8, missedPayments: 0, loanAmount: 60000, collateralValue: 90000 },
  { id: 'APP-02', age: 26, monthlyIncome: 7500, monthlyDebt: 3200, creditHistoryYears: 3, missedPayments: 2, loanAmount: 40000, collateralValue: 45000 },
  { id: 'APP-03', age: 48, monthlyIncome: 28000, monthlyDebt: 6000, creditHistoryYears: 18, missedPayments: 0, loanAmount: 150000, collateralValue: 250000 },
  { id: 'APP-04', age: 31, monthlyIncome: 11000, monthlyDebt: 4800, creditHistoryYears: 6, missedPayments: 1, loanAmount: 50000, collateralValue: 55000 },
  { id: 'APP-05', age: 55, monthlyIncome: 22000, monthlyDebt: 2500, creditHistoryYears: 25, missedPayments: 0, loanAmount: 80000, collateralValue: 160000 },
  { id: 'APP-06', age: 23, monthlyIncome: 5200, monthlyDebt: 2800, creditHistoryYears: 1, missedPayments: 3, loanAmount: 30000, collateralValue: 28000 },
  { id: 'APP-07', age: 41, monthlyIncome: 18500, monthlyDebt: 5500, creditHistoryYears: 12, missedPayments: 0, loanAmount: 95000, collateralValue: 130000 },
  { id: 'APP-08', age: 37, monthlyIncome: 13000, monthlyDebt: 5900, creditHistoryYears: 9, missedPayments: 1, loanAmount: 70000, collateralValue: 80000 },
];
return { applicants };`;

function getBaseUrl(): string {
  const url = process.env.ZAA_BASE_URL?.trim() || "http://localhost:4000";
  return url.replace(/\/+$/, "");
}

function getAuthHeaders(): Record<string, string> {
  const token = requireEnv("ZAA_SESSION_TOKEN");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function apiRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  return await fetch(url, {
    ...options,
    headers: {
      ...getAuthHeaders(),
      ...(options.headers as Record<string, string> | undefined),
    },
  });
}

async function saveNotebookDoc(doc: any): Promise<any> {
  const res = await apiRequest(`/api/notebooks`, {
    method: "POST",
    body: JSON.stringify(doc),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to save notebook doc: HTTP ${res.status} ${text}`);
  }
  return await res.json();
}

function loadFixtureDoc(): any {
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(`Fixture file not found: ${FIXTURE_PATH}`);
  }
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}

function loadHeldOutFixture(): any {
  if (!existsSync(HELDOUT_FIXTURE_PATH)) {
    throw new Error(`Held-out fixture file not found: ${HELDOUT_FIXTURE_PATH}`);
  }
  return JSON.parse(readFileSync(HELDOUT_FIXTURE_PATH, "utf8"));
}

/**
 * Ensures the persistent "rewind-demo" notebook exists in zaatool.
 */
async function ensurePersistentDemoNotebook(): Promise<{ id: string; doc: any }> {
  const notebooks = await listNotebooks();
  const existing = notebooks.find((nb) => nb.name === DEMO_NOTEBOOK_NAME);

  if (existing) {
    const doc = (await getNotebook(existing.id)) as any;
    return { id: existing.id, doc };
  }

  // Create new persistent notebook
  const fixture = loadFixtureDoc();
  const newDoc = {
    name: DEMO_NOTEBOOK_NAME,
    runtime: "javascript",
    steps: fixture.steps,
  };

  const saved = await saveNotebookDoc(newDoc);
  return { id: saved.id, doc: saved };
}

function formatAllCells(steps: any[]): string {
  const parts: string[] = [];
  for (const step of steps ?? []) {
    const code = step.code ?? "";
    if (code.trim().length > 0) {
      parts.push(`--- Cell ID: ${step.id} ---\n\`\`\`javascript\n${code}\n\`\`\``);
    }
  }
  return parts.join("\n\n");
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

// ==========================================
// STEP 1: RESTORE TO GROUND TRUTH
// ==========================================
async function runStep1(): Promise<void> {
  console.log("================================================================================");
  console.log("  REWIND DEMO [STEP 1]: Pulihkan Keadaan Benar (Ground Truth)");
  console.log("================================================================================");

  const { id: demoId } = await ensurePersistentDemoNotebook();
  const fixture = loadFixtureDoc();

  // Reset steps to baseline fixture
  const baselineDoc = {
    id: demoId,
    name: DEMO_NOTEBOOK_NAME,
    runtime: "javascript",
    steps: fixture.steps,
  };

  // Ensure step 0 uses normal baseline seed (APP-01 .. APP-08)
  const baselineSeedCode = `const applicants = [
  { id: 'APP-01', age: 34, monthlyIncome: 15000, monthlyDebt: 3500, creditHistoryYears: 8, missedPayments: 0, loanAmount: 60000, collateralValue: 90000 },
  { id: 'APP-02', age: 26, monthlyIncome: 7500, monthlyDebt: 3200, creditHistoryYears: 3, missedPayments: 2, loanAmount: 40000, collateralValue: 45000 },
  { id: 'APP-03', age: 48, monthlyIncome: 28000, monthlyDebt: 6000, creditHistoryYears: 18, missedPayments: 0, loanAmount: 150000, collateralValue: 250000 },
  { id: 'APP-04', age: 31, monthlyIncome: 11000, monthlyDebt: 4800, creditHistoryYears: 6, missedPayments: 1, loanAmount: 50000, collateralValue: 55000 },
  { id: 'APP-05', age: 55, monthlyIncome: 22000, monthlyDebt: 2500, creditHistoryYears: 25, missedPayments: 0, loanAmount: 80000, collateralValue: 160000 },
  { id: 'APP-06', age: 23, monthlyIncome: 5200, monthlyDebt: 2800, creditHistoryYears: 1, missedPayments: 3, loanAmount: 30000, collateralValue: 28000 },
  { id: 'APP-07', age: 41, monthlyIncome: 18500, monthlyDebt: 5500, creditHistoryYears: 12, missedPayments: 0, loanAmount: 95000, collateralValue: 130000 },
  { id: 'APP-08', age: 37, monthlyIncome: 13000, monthlyDebt: 5900, creditHistoryYears: 9, missedPayments: 1, loanAmount: 70000, collateralValue: 80000 },
];
return { applicants };`;

  baselineDoc.steps[0].code = baselineSeedCode;

  // Restore cell 4 (b143f174) to ground truth penalty (*22)
  const cell4 = baselineDoc.steps.find((s: any) => s.id === MUTATED_CELL_ID);
  if (cell4) {
    cell4.code = `const historyScores = inputs.capacityProfiles.map((a) => {
  let penalty = a.missedPayments * 22;
  let bonus = Math.min(a.creditHistoryYears * 2.5, 25);
  let baseScore = 75 - penalty + bonus;
  if (baseScore > 100) baseScore = 100;
  if (baseScore < 0) baseScore = 0;
  return {
    ...a,
    creditBehaviorScore: Math.round(baseScore * 100) / 100,
  };
});
return { historyScores };`;
  }

  await saveNotebookDoc(baselineDoc);
  console.log(`✓ Notebook "${DEMO_NOTEBOOK_NAME}" (${demoId}) berhasil disinkronkan`);

  // Run notebook
  console.log("⏳ Menjalankan eksekusi reaktif seluruh sel...");
  const runDetail = await runNotebook(demoId);
  const terminalOut = runDetail.cell_results?.[TERMINAL_CELL_ID]?.output as Record<string, any> | undefined;

  if (!terminalOut) {
    console.error("❌ Gagal mengekstrak output dari sel terminal.");
    return;
  }

  const hash = hashValue(terminalOut);

  console.log("\n--- RINGKASAN OUTPUT TERMINAL (PORTFOLIO SCORE) ---");
  console.log(`  Status Eksekusi      : ${runDetail.status.toUpperCase()}`);
  console.log(`  Status Portofolio    : ${terminalOut.portfolioStatus}`);
  console.log(`  Pemohon Disetujui    : ${terminalOut.approvedCount} / ${terminalOut.totalApplicants}`);
  console.log(`  Modal Disalurkan     : Rp ${terminalOut.committedCapital?.toLocaleString()}`);
  console.log(`  Total Cadangan Rugi  : Rp ${terminalOut.totalLossProvision?.toLocaleString()}`);
  console.log(`  Rasio Cadangan Rugi  : ${terminalOut.lossProvisionRatioPct}%`);
  console.log(`  Output Hash (Truth)  : ${hash}`);
  console.log("--------------------------------------------------------------------------------\n");
}

// ==========================================
// STEP 2: INJECT BUG b143f174
// ==========================================
async function runStep2(): Promise<void> {
  console.log("================================================================================");
  console.log("  REWIND DEMO [STEP 2]: Suntikkan Bug b143f174 (penalty *22 -> *23)");
  console.log("================================================================================");

  const { id: demoId } = await ensurePersistentDemoNotebook();
  const currentDoc = (await getNotebook(demoId)) as any;

  // Ensure step 0 uses normal baseline seed (APP-01 .. APP-08)
  currentDoc.steps[0].code = BASELINE_SEED_CODE;

  // Mutate cell b143f174
  const cell4 = currentDoc.steps.find((s: any) => s.id === MUTATED_CELL_ID);
  if (!cell4) {
    throw new Error(`Sel mutasi ${MUTATED_CELL_ID} tidak ditemukan dalam notebook.`);
  }

  cell4.code = `const historyScores = inputs.capacityProfiles.map((a) => {
  let penalty = a.missedPayments * 23;
  let bonus = Math.min(a.creditHistoryYears * 2.5, 25);
  let baseScore = 75 - penalty + bonus;
  if (baseScore > 100) baseScore = 100;
  if (baseScore < 0) baseScore = 0;
  return {
    ...a,
    creditBehaviorScore: Math.round(baseScore * 100) / 100,
  };
});
return { historyScores };`;

  await saveNotebookDoc(currentDoc);
  console.log(`✓ Bug disuntikkan ke sel b143f174 (historyScores): penalty * 22 -> * 23`);

  // Run notebook
  console.log("⏳ Menjalankan eksekusi reaktif untuk menghasilkan gejala...");
  const runDetail = await runNotebook(demoId);
  const terminalOut = runDetail.cell_results?.[TERMINAL_CELL_ID]?.output as Record<string, any> | undefined;

  const hash = terminalOut ? hashValue(terminalOut) : "ERROR";

  console.log("\n--- STATUS GANGGUAN PADA SEL TERMINAL ---");
  console.log(`  Status Eksekusi      : ${runDetail.status.toUpperCase()}`);
  if (terminalOut) {
    console.log(`  Status Portofolio    : ${terminalOut.portfolioStatus}`);
    console.log(`  Pemohon Disetujui    : ${terminalOut.approvedCount} / ${terminalOut.totalApplicants}`);
    console.log(`  Total Cadangan Rugi  : Rp ${terminalOut.totalLossProvision?.toLocaleString()}`);
    console.log(`  Rasio Cadangan Rugi  : ${terminalOut.lossProvisionRatioPct}%`);
  }
  console.log(`  Faulty Output Hash   : ${hash}`);
  console.log("--------------------------------------------------------------------------------\n");
}

// ==========================================
// STEP 3: RUN REWIND ARM LIVE
// ==========================================
async function runStep3(seed = 42, customModel?: string): Promise<void> {
  console.log("================================================================================");
  console.log("  REWIND DEMO [STEP 3]: Jalankan Agen Rewind (Materialized Scope Replay)");
  console.log("================================================================================");

  const apiKey = requireEnv("FEATHERLESS_API_KEY");
  const baseUrl = (process.env.FEATHERLESS_BASE_URL?.trim() || "https://api.featherless.ai/v1").replace(/\/+$/, "");
  const model = customModel || process.env.MODEL_PRIMARY || "deepseek-ai/DeepSeek-V4-Flash-0731";
  const maxTokens = parseInt(process.env.ARM_MAX_TOKENS || "16000", 10);
  const maxTurns = 15;

  const { id: demoId } = await ensurePersistentDemoNotebook();
  const fixture = loadFixtureDoc();

  console.log(`Konfigurasi Model : ${model} | Seed: ${seed} | MaxTokens: ${maxTokens}`);
  console.log(`Target Notebook   : "${DEMO_NOTEBOOK_NAME}" (${demoId})`);
  console.log("--------------------------------------------------------------------------------");

  // 1. Get baseline run and actual run
  // Baseline run from ground-truth fixture
  const baselineDoc = {
    id: demoId,
    name: DEMO_NOTEBOOK_NAME,
    runtime: "javascript",
    steps: fixture.steps,
  };
  // Ensure baseline doc has original code
  const bCell4 = baselineDoc.steps.find((s: any) => s.id === MUTATED_CELL_ID);
  if (bCell4) {
    bCell4.code = `const historyScores = inputs.capacityProfiles.map((a) => {\n  let penalty = a.missedPayments * 22;\n  let bonus = Math.min(a.creditHistoryYears * 2.5, 25);\n  let baseScore = 75 - penalty + bonus;\n  if (baseScore > 100) baseScore = 100;\n  if (baseScore < 0) baseScore = 0;\n  return {\n    ...a,\n    creditBehaviorScore: Math.round(baseScore * 100) / 100,\n  };\n});\nreturn { historyScores };`;
  }

  // Save baseline doc temporarily to run baseline, then restore faulty
  const currentFaultyDoc = (await getNotebook(demoId)) as any;
  await saveNotebookDoc(baselineDoc);
  const baselineRun = await runNotebook(demoId);

  // Restore current faulty state
  await saveNotebookDoc(currentFaultyDoc);
  const actualRun = await runNotebook(demoId);

  const expectedResult = baselineRun.cell_results?.[TERMINAL_CELL_ID];
  const expectedOutput = expectedResult?.output || (baselineRun as any).outputs || null;

  const actualResult = actualRun.cell_results?.[TERMINAL_CELL_ID];
  const actualOutput = actualResult?.output || ((actualResult as any)?.error ? { error: (actualResult as any).error } : ((actualRun as any).error ? { error: (actualRun as any).error } : null));

  const baselineTruthHash = hashValue(expectedOutput);

  // Build System & Initial Prompts
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

  const initialUserMessage = `Notebook: "${DEMO_NOTEBOOK_NAME}" (${demoId})

=== SYMPTOM ===
Expected notebook final output (from terminal cell before the bug):
\`\`\`json
${JSON.stringify(expectedOutput, null, 2)}
\`\`\`

Actual notebook final output (current faulty state):
Status: ${actualRun.status}
Output:
\`\`\`json
${JSON.stringify(actualOutput, null, 2)}
\`\`\`

=== NOTEBOOK SOURCE CELLS ===
${formatAllCells(currentFaultyDoc.steps)}

Investigate the cells and their upstream state, locate the bug, repair it with notebook_edit_cell, and finish.`;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Turn 1 of ${maxTurns}.\n\n${initialUserMessage}` },
  ];

  let totalPromptTokens = 0;
  let totalReasoningTokens = 0;
  let totalAnswerTokens = 0;
  let totalTokens = 0;
  const editedCells: string[] = [];
  let finishReason = "";

  const startTime = Date.now();

  for (let turn = 1; turn <= maxTurns; turn++) {
    const turnHeader = `[Turn ${String(turn).padStart(2, " ")}/${maxTurns}]`;

    const reqBody = {
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0,
      seed,
      reasoning_effort: "low",
    };

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(reqBody),
    });

    if (!res.ok) {
      console.log(`${turnHeader} HTTP Error ${res.status} dari API model.`);
      break;
    }

    const data = (await res.json()) as any;
    const choice = data.choices?.[0];
    const content = choice?.message?.content || "";
    const reasoning = choice?.message?.reasoning || "";

    const pTokens = data.usage?.prompt_tokens || 0;
    const cTokens = data.usage?.completion_tokens || 0;
    let rTokens = data.usage?.completion_tokens_details?.reasoning_tokens;
    if (rTokens === undefined) {
      rTokens = reasoning.length > 0 ? Math.min(cTokens, Math.max(1, Math.round(reasoning.length / 3.8))) : 0;
    }
    const aTokens = Math.max(0, cTokens - rTokens);

    totalPromptTokens += pTokens;
    totalReasoningTokens += rTokens;
    totalAnswerTokens += aTokens;
    totalTokens += (data.usage?.total_tokens || (pTokens + cTokens));

    messages.push({ role: "assistant", content });

    const action = parseModelAction(content);
    if (!action) {
      console.log(`${turnHeader} Format tidak valid. Meminta perbaikan format...`);
      messages.push({
        role: "user",
        content: `Turn ${turn + 1} of ${maxTurns}.\nInvalid format. You must respond with EXACTLY ONE fenced JSON code block:\n\`\`\`json\n{"action": "..."}\n\`\`\``,
      });
      continue;
    }

    const nextTurnHeader = turn < maxTurns ? `Turn ${turn + 1} of ${maxTurns}.\n\n` : "";

    // 1. FINISH
    if (action.action === "finish") {
      finishReason = String(action.reason || "Perbaikan selesai");
      const shortReason = finishReason.length > 45 ? `${finishReason.slice(0, 42)}...` : finishReason;
      console.log(`${turnHeader} SELESAI  │ Alasan: ${shortReason}`);
      break;
    }

    // 2. NOTEBOOK_READ
    if (action.action === "notebook_read") {
      const cellId = String(action.cell || "");
      const shortId = cellId.slice(0, 8);
      const name = CELL_NAMES[cellId] || "unknown";
      console.log(`${turnHeader} BACA     │ Sel: ${shortId} (${name}) + MSR Scope`);

      const targetStep = currentFaultyDoc.steps.find((s: any) => s.id === cellId);
      const code = targetStep?.code || "";
      const scopeResult = scopeBefore(baselineDoc, baselineRun, cellId);
      const { formatted, truncated } = formatScopeWithTruncation(scopeResult.scope);

      messages.push({
        role: "user",
        content: `${nextTurnHeader}Cell ${cellId} source:\n\`\`\`javascript\n${code}\n\`\`\`\n\nUpstream state at this cell (recorded from the last good run):\n\`\`\`json\n${formatted}\n\`\`\``,
      });
      continue;
    }

    // 3. NOTEBOOK_RUN_CELL
    if (action.action === "notebook_run_cell") {
      const cellId = String(action.cell || "");
      const shortId = cellId.slice(0, 8);
      const name = CELL_NAMES[cellId] || "unknown";
      console.log(`${turnHeader} JALANKAN │ Sel: ${shortId} (${name}) [Scope Injeksi Otomatis]`);

      let input = action.input;
      if (!input || Object.keys(input).length === 0) {
        const scopeResult = scopeBefore(baselineDoc, baselineRun, cellId);
        input = scopeResult.scope;
      }

      const runRes = await runCell(demoId, cellId, input as Record<string, unknown>);
      const resText = runRes.error
        ? `Cell execution failed:\n${runRes.error}`
        : `Cell output:\n${JSON.stringify(runRes.output, null, 2)}`;
      messages.push({ role: "user", content: `${nextTurnHeader}${resText}` });
      continue;
    }

    // 4. NOTEBOOK_EDIT_CELL
    if (action.action === "notebook_edit_cell") {
      const cellId = String(action.cell || "");
      const code = String(action.code || "");
      const shortId = cellId.slice(0, 8);
      const name = CELL_NAMES[cellId] || "unknown";

      console.log(`${turnHeader} EDIT     │ Sel: ${shortId} (${name}) [Jeda 1.5s -> Sync Browser]`);

      // PAUSE 1.5 seconds so camera captures live state transition in browser
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const targetStep = currentFaultyDoc.steps.find((s: any) => s.id === cellId);
      if (targetStep) {
        targetStep.code = code;
        await saveNotebookDoc(currentFaultyDoc);
        if (!editedCells.includes(cellId)) editedCells.push(cellId);
        messages.push({ role: "user", content: `${nextTurnHeader}Cell ${cellId} updated successfully.` });
      } else {
        messages.push({ role: "user", content: `${nextTurnHeader}Error: cell ${cellId} not found.` });
      }
      continue;
    }

    // Unknown
    messages.push({
      role: "user",
      content: `${nextTurnHeader}Unknown action "${action.action}".`,
    });
  }

  const wallMs = Date.now() - startTime;

  // Run final notebook to verify visible fix
  const finalRun = await runNotebook(demoId);
  const finalOutput = finalRun.cell_results?.[TERMINAL_CELL_ID]?.output;
  const finalHash = finalOutput ? hashValue(finalOutput) : "ERROR";
  const visibleResolved = finalHash === baselineTruthHash;

  console.log("--------------------------------------------------------------------------------");
  console.log(`Waktu Eksekusi    : ${(wallMs / 1000).toFixed(1)}s | Sel Diedit: ${editedCells.length} sel`);
  console.log(`Konsumsi Token    : ${totalTokens.toLocaleString()} (P:${totalPromptTokens.toLocaleString()}, R:${totalReasoningTokens.toLocaleString()}, A:${totalAnswerTokens.toLocaleString()})`);
  console.log(`Output Terminal   : Hash ${finalHash}`);
  console.log(`Hasil Terlihat    : ${visibleResolved ? "✓ BERHASIL MEMPERBAIKI (Assertion Lolos)" : "✗ GAGAL (Assertion Mismatch)"}`);
  console.log("--------------------------------------------------------------------------------\n");
}

// ==========================================
// STEP 4: HELDOUT INDEPENDENT CHECK
// ==========================================
async function runStep4(): Promise<void> {
  console.log("================================================================================");
  console.log("  REWIND DEMO [STEP 4]: Uji Held-Out Data (Independen)");
  console.log("================================================================================");

  const { id: demoId } = await ensurePersistentDemoNotebook();
  const heldoutFixture = loadHeldOutFixture();
  const currentDoc = (await getNotebook(demoId)) as any;

  const heldoutSeedCode = heldoutFixture.heldoutSeedCode || heldoutFixture.steps?.[0]?.code;
  const heldOutTruthHash = heldoutFixture.heldOutTruthHash;

  if (!heldoutSeedCode || !heldOutTruthHash) {
    throw new Error("Fixture held-out tidak memiliki heldoutSeedCode atau heldOutTruthHash.");
  }

  console.log(`1. Memasang benih input baru (Held-Out Seed: APP-H101 .. APP-H110)...`);
  currentDoc.steps[0].code = heldoutSeedCode;
  await saveNotebookDoc(currentDoc);

  console.log(`2. Menjalankan seluruh alur notebook pada data held-out...`);
  const heldoutRun = await runNotebook(demoId);
  const terminalOut = heldoutRun.cell_results?.[TERMINAL_CELL_ID]?.output;

  if (!terminalOut) {
    console.log(`❌ Eksekusi held-out gagal: ${(heldoutRun as any).error || "Output terminal kosong"}`);
    return;
  }

  const actualHeldOutHash = hashValue(terminalOut);
  const passed = actualHeldOutHash === heldOutTruthHash;

  console.log("\n--- HASIL EVALUASI DATA HELD-OUT ---");
  console.log(`  Expected Truth Hash  : ${heldOutTruthHash}`);
  console.log(`  Actual Output Hash   : ${actualHeldOutHash}`);
  console.log("--------------------------------------------------------------------------------");
  if (passed) {
    console.log("  >>> STATUS: LULUS (Perbaikan Sejati / Genuine Resolution) <<<");
    console.log("  Perbaikan kode bekerja secara umum untuk sembarang input baru.");
  } else {
    console.log("  >>> STATUS: GAGAL (Lucky-Pass / Kompensasi Parsial Terdeteksi) <<<");
    console.log("  Perbaikan hanya menambal sampel terlihat, tetapi gagal generalisasi.");
  }
  console.log("================================================================================\n");
}

// ==========================================
// CLI ARGUMENT PARSER & ENTRYPOINT
// ==========================================
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let step = 1;
  let seed = 42;
  let model: string | undefined = undefined;

  for (const arg of args) {
    if (arg.startsWith("--step=")) {
      step = parseInt(arg.split("=")[1], 10);
    } else if (arg.startsWith("--seed=")) {
      seed = parseInt(arg.split("=")[1], 10);
    } else if (arg.startsWith("--model=")) {
      model = arg.split("=")[1];
    }
  }

  if (step === 1) {
    await runStep1();
  } else if (step === 2) {
    await runStep2();
  } else if (step === 3) {
    await runStep3(seed, model);
  } else if (step === 4) {
    await runStep4();
  } else {
    console.error(`Unknown step "${step}". Gunakan --step=1, --step=2, --step=3, atau --step=4.`);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].includes("demo")) {
  main().catch((err) => {
    console.error(`Demo execution error:`, err);
    process.exit(1);
  });
}
