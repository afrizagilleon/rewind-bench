/**
 * Script to generate, create via REST, verify 10x determinism, and compute held-out truth hashes
 * for the 6 redesigned benchmark notebooks with randomUUID() cell IDs and varied lengths (6, 7, 7, 8, 8, 9) (R10.1 & R7.0).
 *
 * Generates two fixtures per notebook:
 * 1. fixtures/designed/<name>.json (primary seed doc + heldOutTruthHash)
 * 2. fixtures/designed/<name>.heldout.json (held-out seed doc + heldOutTruthHash)
 */

import { listNotebooks, requireEnv } from "../src/client";
import { hashValue } from "../src/ledger";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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
  const res = await fetch(url, {
    ...options,
    headers: {
      ...getAuthHeaders(),
      ...(options.headers as Record<string, string> | undefined),
    },
  });
  return res;
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

async function duplicateNotebook(notebookId: string): Promise<{ id: string; name: string }> {
  const res = await apiRequest(`/api/notebooks/${encodeURIComponent(notebookId)}/duplicate`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`Failed to duplicate notebook ${notebookId}: HTTP ${res.status}`);
  }
  return (await res.json()) as { id: string; name: string };
}

async function deleteNotebook(notebookId: string, name?: string): Promise<void> {
  if (name && !name.startsWith("zz-rewind-scratch-") && !name.endsWith("-copy")) {
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

async function pollRunFinished(
  notebookId: string,
  runId: string,
  pollIntervalMs = 200,
  timeoutMs = 60000
): Promise<any> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const res = await apiRequest(
      `/api/notebooks/${encodeURIComponent(notebookId)}/runs/${encodeURIComponent(runId)}`
    );
    if (res.ok) {
      const run = (await res.json()) as { status: string; cell_results?: Record<string, any>; error?: string };
      if (run.status !== "running") {
        if (!run.cell_results || Object.keys(run.cell_results).length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          const retryRes = await apiRequest(
            `/api/notebooks/${encodeURIComponent(notebookId)}/runs/${encodeURIComponent(runId)}`
          );
          if (retryRes.ok) return await retryRes.json();
        }
        return run;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Timeout polling run ${runId}`);
}

async function runNotebook(notebookId: string): Promise<any> {
  const res = await apiRequest(`/api/notebooks/${encodeURIComponent(notebookId)}/run`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to start run for ${notebookId}: HTTP ${res.status}`);
  }
  const { runId } = (await res.json()) as { runId: string };
  return await pollRunFinished(notebookId, runId);
}

// -------------------------------------------------------------
// NOTEBOOK DEFINITIONS & HELDOUT SEEDS
// -------------------------------------------------------------

export interface DesignedNotebookSpec {
  name: string;
  steps: any[];
  heldoutSeedCode: string;
}

export function createDesignedNotebookDefinitions(): DesignedNotebookSpec[] {
  return [
    // 1. rb-designed-sales-aggregation (6 cells)
    {
      name: "rb-designed-sales-aggregation",
      heldoutSeedCode: `const transactions = [
  { id: 'H201', sku: 'SERVER-BLADE', category: 'Electronics', qty: 3, unitPrice: 2200, discountPct: 15, region: 'Denpasar', customerTier: 'Platinum' },
  { id: 'H202', sku: 'OFFICE-SOFA', category: 'Furniture', qty: 2, unitPrice: 850, discountPct: 10, region: 'Jakarta', customerTier: 'Gold' },
  { id: 'H203', sku: 'DEV-TABLET', category: 'Electronics', qty: 5, unitPrice: 400, discountPct: 5, region: 'Surabaya', customerTier: 'Silver' },
  { id: 'H204', sku: 'DATA-MINING-BOOK', category: 'Books', qty: 10, unitPrice: 65, discountPct: 0, region: 'Bandung', customerTier: 'Bronze' },
  { id: 'H205', sku: 'CONFERENCE-MIC', category: 'Accessories', qty: 4, unitPrice: 120, discountPct: 10, region: 'Medan', customerTier: 'Gold' },
  { id: 'H206', sku: 'STORAGE-ARRAY', category: 'Electronics', qty: 1, unitPrice: 3400, discountPct: 20, region: 'Jakarta', customerTier: 'Platinum' },
  { id: 'H207', sku: 'MODULAR-DESK', category: 'Furniture', qty: 3, unitPrice: 320, discountPct: 0, region: 'Denpasar', customerTier: 'Silver' },
  { id: 'H208', sku: 'AI-ENG-HANDBOOK', category: 'Books', qty: 6, unitPrice: 80, discountPct: 5, region: 'Surabaya', customerTier: 'Platinum' },
  { id: 'H209', sku: 'FIBER-SWITCH', category: 'Electronics', qty: 2, unitPrice: 950, discountPct: 8, region: 'Bandung', customerTier: 'Gold' },
  { id: 'H210', sku: 'USB4-HUB', category: 'Accessories', qty: 12, unitPrice: 35, discountPct: 15, region: 'Medan', customerTier: 'Bronze' },
  { id: 'H211', sku: 'GAMING-PANEL', category: 'Electronics', qty: 3, unitPrice: 520, discountPct: 12, region: 'Jakarta', customerTier: 'Silver' },
  { id: 'H212', sku: 'SHELVING-UNIT', category: 'Furniture', qty: 4, unitPrice: 190, discountPct: 0, region: 'Surabaya', customerTier: 'Bronze' },
  { id: 'H213', sku: 'SEC-TOKEN-PACK', category: 'Accessories', qty: 15, unitPrice: 20, discountPct: 25, region: 'Bandung', customerTier: 'Platinum' },
  { id: 'H214', sku: 'SYSADMIN-MANUAL', category: 'Books', qty: 8, unitPrice: 45, discountPct: 0, region: 'Denpasar', customerTier: 'Gold' },
];
return { transactions };`,
      steps: [
        {
          id: randomUUID(),
          kind: "cell",
          code: `const transactions = [
  { id: 'T101', sku: 'LAPTOP-PRO', category: 'Electronics', qty: 2, unitPrice: 1200, discountPct: 10, region: 'Jakarta', customerTier: 'Platinum' },
  { id: 'T102', sku: 'DESK-STAND', category: 'Furniture', qty: 4, unitPrice: 150, discountPct: 5, region: 'Surabaya', customerTier: 'Gold' },
  { id: 'T103', sku: 'MECH-KEYBOARD', category: 'Electronics', qty: 3, unitPrice: 180, discountPct: 0, region: 'Bandung', customerTier: 'Silver' },
  { id: 'T104', sku: 'ERG-CHAIR', category: 'Furniture', qty: 1, unitPrice: 450, discountPct: 15, region: 'Medan', customerTier: 'Platinum' },
  { id: 'T105', sku: 'DEV-BOOK-JS', category: 'Books', qty: 5, unitPrice: 40, discountPct: 0, region: 'Denpasar', customerTier: 'Bronze' },
  { id: 'T106', sku: 'MONITOR-4K', category: 'Electronics', qty: 2, unitPrice: 600, discountPct: 8, region: 'Jakarta', customerTier: 'Gold' },
  { id: 'T107', sku: 'USB-C-DOCK', category: 'Electronics', qty: 6, unitPrice: 90, discountPct: 12, region: 'Surabaya', customerTier: 'Silver' },
  { id: 'T108', sku: 'DESK-LAMP', category: 'Furniture', qty: 3, unitPrice: 70, discountPct: 0, region: 'Bandung', customerTier: 'Bronze' },
  { id: 'T109', sku: 'DEV-BOOK-ALGO', category: 'Books', qty: 4, unitPrice: 55, discountPct: 5, region: 'Jakarta', customerTier: 'Platinum' },
  { id: 'T110', sku: 'NOISE-CANC-HEAD', category: 'Electronics', qty: 2, unitPrice: 280, discountPct: 10, region: 'Medan', customerTier: 'Gold' },
  { id: 'T111', sku: 'NOTEBOOK-CASE', category: 'Accessories', qty: 8, unitPrice: 25, discountPct: 20, region: 'Denpasar', customerTier: 'Silver' },
  { id: 'T112', sku: 'MOUSE-WIRELESS', category: 'Electronics', qty: 5, unitPrice: 45, discountPct: 0, region: 'Surabaya', customerTier: 'Platinum' },
];
return { transactions };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const lineItems = inputs.transactions.map((tx) => {
  const baseGross = tx.qty * tx.unitPrice;
  const discountAmount = baseGross * (tx.discountPct / 100);
  const netGross = baseGross - discountAmount;
  return {
    id: tx.id,
    sku: tx.sku,
    category: tx.category,
    region: tx.region,
    customerTier: tx.customerTier,
    netGross: Math.round(netGross * 100) / 100,
  };
});
return { lineItems };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const TAX_RATES = {
  Jakarta: 0.11,
  Surabaya: 0.10,
  Bandung: 0.10,
  Medan: 0.11,
  Denpasar: 0.12,
};
const taxedItems = inputs.lineItems.map((item) => {
  const rate = TAX_RATES[item.region] || 0.10;
  const tax = item.netGross * rate;
  return {
    ...item,
    taxAmount: Math.round(tax * 100) / 100,
    totalWithTax: Math.round((item.netGross + tax) * 100) / 100,
  };
});
return { taxedItems };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const rebatedItems = inputs.taxedItems.map((item) => {
  let rebateRate = 0;
  if (item.customerTier === 'Platinum' && item.netGross > 400) {
    rebateRate = 0.05;
  } else if (item.customerTier === 'Gold' && item.netGross > 200) {
    rebateRate = 0.03;
  } else if (item.customerTier === 'Silver') {
    rebateRate = 0.01;
  }
  const rebate = item.totalWithTax * rebateRate;
  return {
    ...item,
    rebateAmount: Math.round(rebate * 100) / 100,
  };
});
return { rebatedItems };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const COMMISSION_RATES = {
  Electronics: 0.03,
  Furniture: 0.05,
  Books: 0.02,
  Accessories: 0.06,
};
const commissionedItems = inputs.rebatedItems.map((item) => {
  const rate = COMMISSION_RATES[item.category] || 0.025;
  const comm = item.netGross * rate;
  const fulfillment = item.region === 'Jakarta' || item.region === 'Surabaya' ? 'DirectHub' : 'RegionalWarehouse';
  const surcharge = fulfillment === 'RegionalWarehouse' ? 18.5 : 8.0;
  return {
    ...item,
    commissionAmount: Math.round(comm * 100) / 100,
    fulfillment,
    logisticsSurcharge: surcharge,
  };
});
return { commissionedItems };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const items = inputs.commissionedItems;
let sumGross = 0;
let sumTax = 0;
let sumRebate = 0;
let sumCommission = 0;
let sumSurcharge = 0;

for (const it of items) {
  sumGross += it.netGross;
  sumTax += it.taxAmount;
  sumRebate += it.rebateAmount;
  sumCommission += it.commissionAmount;
  sumSurcharge += it.logisticsSurcharge;
}

const netSettlement = sumGross + sumTax - sumRebate - sumCommission - sumSurcharge;
const effectiveMargin = Math.round((netSettlement / (sumGross || 1)) * 10000) / 100;

return {
  transactionCount: items.length,
  totalTaxCollected: Math.round(sumTax * 100) / 100,
  netSettlement: Math.round(netSettlement * 100) / 100,
  effectiveMarginPct: effectiveMargin,
  auditPassed: netSettlement > 0 && items.length > 0,
};`,
        },
      ],
    },

    // 2. rb-designed-risk-assessment (7 cells)
    {
      name: "rb-designed-risk-assessment",
      heldoutSeedCode: `const applicants = [
  { id: 'APP-H101', age: 29, monthlyIncome: 12500, monthlyDebt: 2800, creditHistoryYears: 5, missedPayments: 0, loanAmount: 45000, collateralValue: 70000 },
  { id: 'APP-H102', age: 44, monthlyIncome: 32000, monthlyDebt: 8500, creditHistoryYears: 16, missedPayments: 1, loanAmount: 180000, collateralValue: 290000 },
  { id: 'APP-H103', age: 22, monthlyIncome: 4800, monthlyDebt: 2100, creditHistoryYears: 2, missedPayments: 2, loanAmount: 22000, collateralValue: 20000 },
  { id: 'APP-H104', age: 52, monthlyIncome: 19000, monthlyDebt: 3100, creditHistoryYears: 22, missedPayments: 0, loanAmount: 75000, collateralValue: 140000 },
  { id: 'APP-H105', age: 36, monthlyIncome: 16500, monthlyDebt: 6200, creditHistoryYears: 10, missedPayments: 0, loanAmount: 85000, collateralValue: 110000 },
  { id: 'APP-H106', age: 61, monthlyIncome: 24000, monthlyDebt: 1800, creditHistoryYears: 30, missedPayments: 0, loanAmount: 90000, collateralValue: 210000 },
  { id: 'APP-H107', age: 27, monthlyIncome: 8200, monthlyDebt: 4100, creditHistoryYears: 4, missedPayments: 3, loanAmount: 35000, collateralValue: 32000 },
  { id: 'APP-H108', age: 39, monthlyIncome: 14000, monthlyDebt: 4900, creditHistoryYears: 11, missedPayments: 0, loanAmount: 65000, collateralValue: 85000 },
  { id: 'APP-H109', age: 33, monthlyIncome: 10500, monthlyDebt: 3900, creditHistoryYears: 7, missedPayments: 1, loanAmount: 40000, collateralValue: 48000 },
  { id: 'APP-H110', age: 46, monthlyIncome: 27500, monthlyDebt: 5800, creditHistoryYears: 19, missedPayments: 0, loanAmount: 130000, collateralValue: 220000 },
];
return { applicants };`,
      steps: [
        {
          id: randomUUID(),
          kind: "cell",
          code: `const applicants = [
  { id: 'APP-01', age: 34, monthlyIncome: 15000, monthlyDebt: 3500, creditHistoryYears: 8, missedPayments: 0, loanAmount: 60000, collateralValue: 90000 },
  { id: 'APP-02', age: 26, monthlyIncome: 7500, monthlyDebt: 3200, creditHistoryYears: 3, missedPayments: 2, loanAmount: 40000, collateralValue: 45000 },
  { id: 'APP-03', age: 48, monthlyIncome: 28000, monthlyDebt: 6000, creditHistoryYears: 18, missedPayments: 0, loanAmount: 150000, collateralValue: 250000 },
  { id: 'APP-04', age: 31, monthlyIncome: 11000, monthlyDebt: 4800, creditHistoryYears: 6, missedPayments: 1, loanAmount: 50000, collateralValue: 55000 },
  { id: 'APP-05', age: 55, monthlyIncome: 22000, monthlyDebt: 2500, creditHistoryYears: 25, missedPayments: 0, loanAmount: 80000, collateralValue: 160000 },
  { id: 'APP-06', age: 23, monthlyIncome: 5200, monthlyDebt: 2800, creditHistoryYears: 1, missedPayments: 3, loanAmount: 30000, collateralValue: 28000 },
  { id: 'APP-07', age: 41, monthlyIncome: 18500, monthlyDebt: 5500, creditHistoryYears: 12, missedPayments: 0, loanAmount: 95000, collateralValue: 130000 },
  { id: 'APP-08', age: 37, monthlyIncome: 13000, monthlyDebt: 5900, creditHistoryYears: 9, missedPayments: 1, loanAmount: 70000, collateralValue: 80000 },
];
return { applicants };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const dtiProfiles = inputs.applicants.map((a) => {
  const dti = (a.monthlyDebt / a.monthlyIncome) * 100;
  let dtiScore = 100 - (dti * 1.5);
  if (dtiScore < 0) dtiScore = 0;
  return {
    ...a,
    dtiRatio: Math.round(dti * 100) / 100,
    dtiScore: Math.round(dtiScore * 100) / 100,
  };
});
return { dtiProfiles };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const ltvProfiles = inputs.dtiProfiles.map((a) => {
  const ltv = (a.loanAmount / a.collateralValue) * 100;
  let ltvScore = 100 - ((ltv - 50) * 1.2);
  if (ltvScore > 100) ltvScore = 100;
  if (ltvScore < 0) ltvScore = 0;
  return {
    ...a,
    ltvRatio: Math.round(ltv * 100) / 100,
    ltvScore: Math.round(ltvScore * 100) / 100,
  };
});
return { ltvProfiles };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const capacityProfiles = inputs.ltvProfiles.map((a) => {
  const estimatedMonthlyInstallment = (a.loanAmount * 0.08) / 12;
  const disposableIncome = a.monthlyIncome - a.monthlyDebt - estimatedMonthlyInstallment;
  const capacityRatio = disposableIncome / a.monthlyIncome;
  let capacityScore = capacityRatio * 150;
  if (capacityScore > 100) capacityScore = 100;
  if (capacityScore < 0) capacityScore = 0;
  return {
    ...a,
    disposableIncome: Math.round(disposableIncome),
    capacityScore: Math.round(capacityScore * 100) / 100,
  };
});
return { capacityProfiles };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const historyScores = inputs.capacityProfiles.map((a) => {
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
return { historyScores };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const riskScores = inputs.historyScores.map((a) => {
  const composite = (a.dtiScore * 0.30) + (a.ltvScore * 0.25) + (a.capacityScore * 0.25) + (a.creditBehaviorScore * 0.20);
  const riskIndex = 100 - composite;
  const stressedIndex = riskIndex * 1.15;
  const expectedDefaultRate = Math.pow(stressedIndex / 100, 2) * 0.25;
  const expectedLoss = a.loanAmount * expectedDefaultRate;
  const approved = stressedIndex < 42;
  return {
    id: a.id,
    approved,
    loanAmount: a.loanAmount,
    riskIndex: Math.round(riskIndex * 100) / 100,
    expectedLoss: Math.round(expectedLoss * 100) / 100,
  };
});
return { riskScores };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const portfolio = inputs.riskScores;
let approvedCount = 0;
let committedCapital = 0;
let totalLossProvision = 0;

for (const p of portfolio) {
  if (p.approved) {
    approvedCount++;
    committedCapital += p.loanAmount;
    totalLossProvision += p.expectedLoss;
  }
}

const lossProvisionRatio = Math.round((totalLossProvision / (committedCapital || 1)) * 10000) / 100;

return {
  totalApplicants: portfolio.length,
  approvedCount,
  committedCapital,
  totalLossProvision: Math.round(totalLossProvision * 100) / 100,
  lossProvisionRatioPct: lossProvisionRatio,
  portfolioStatus: approvedCount >= 4 ? 'HEALTHY' : 'CONSTRAINED',
};`,
        },
      ],
    },

    // 3. rb-designed-text-pipeline (7 cells)
    {
      name: "rb-designed-text-pipeline",
      heldoutSeedCode: `const documents = [
  'Microservices architecture and container orchestration streamline scalable distributed software deployments.',
  'Cybersecurity frameworks require continuous automated vulnerability detection and proactive compliance auditing.',
  'Real-time telemetry and distributed stream processing empower intelligent cloud monitoring infrastructures.',
  'Scalable database clusters optimize high-throughput transaction processing for modern financial systems.',
  'Distributed consensus algorithms secure multi-region cloud applications against network partitions.',
  'Continuous delivery pipelines automate regression testing and resilient enterprise microservice deployments.',
  'Intelligent observability platforms analyze streaming telemetry metrics using machine learning anomaly detection.',
  'Containerized serverless applications accelerate cloud computing transformations with elastic scalability.',
  'Automated security scanning and cryptographic validation ensure resilient enterprise software supply chains.',
  'Modern cloud native architectures integrate distributed telemetry stream pipelines for operational intelligence.',
];
return { documents };`,
      steps: [
        {
          id: randomUUID(),
          kind: "cell",
          code: `const documents = [
  'Data science and artificial intelligence transform modern enterprise software architectures rapidly.',
  'Enterprise cloud computing accelerates digital transformation through reliable data pipelines.',
  'Machine learning models require clean data pipelines and continuous validation systems.',
  'Modern software architectures leverage distributed data processing and resilient cloud infrastructures.',
  'Natural language processing enhances enterprise automation through intelligent text analysis.',
  'Distributed systems process massive datasets using scalable cloud computing architectures.',
  'Continuous integration and automated validation ensure reliable machine learning deployment.',
  'Artificial intelligence and cloud computing empower enterprise data intelligence workflows.',
];
return { documents };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const STOPWORDS = new Set(['and', 'the', 'is', 'in', 'to', 'through', 'using', 'of', 'for', 'a']);
const tokenizedDocs = inputs.documents.map((doc, docId) => {
  const words = doc
    .toLowerCase()
    .replace(/[^a-z0-9\\s]/g, '')
    .split(/\\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return { docId, words };
});
return { tokenizedDocs };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const docCount = inputs.tokenizedDocs.length;
const docFreq = {};
const termFreqs = [];

for (const d of inputs.tokenizedDocs) {
  const tf = {};
  const seenInDoc = new Set();
  for (const w of d.words) {
    tf[w] = (tf[w] || 0) + 1;
    seenInDoc.add(w);
  }
  termFreqs.push({ docId: d.docId, tf, wordCount: d.words.length });
  for (const w of seenInDoc) {
    docFreq[w] = (docFreq[w] || 0) + 1;
  }
}

return { docCount, docFreq, termFreqs };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const { docCount, docFreq, termFreqs } = inputs;
const idfMap = {};
for (const [w, df] of Object.entries(docFreq)) {
  const idf = Math.log((docCount + 1) / (df + 1)) + 1;
  idfMap[w] = Math.round(idf * 1000) / 1000;
}
return { idfMap, termFreqs };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const { idfMap, termFreqs } = inputs;
const docVectors = termFreqs.map((d) => {
  const vector = {};
  let sumSq = 0;
  for (const [w, count] of Object.entries(d.tf)) {
    const tf = count / d.wordCount;
    const idf = idfMap[w] || 1;
    const score = tf * idf;
    vector[w] = score;
    sumSq += score * score;
  }
  const magnitude = Math.sqrt(sumSq) || 1;
  const normalized = {};
  for (const [w, sc] of Object.entries(vector)) {
    normalized[w] = Math.round((sc / magnitude) * 1000) / 1000;
  }
  return { docId: d.docId, vector: normalized };
});
return { docVectors };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const vectors = inputs.docVectors;
const pairwiseScores = [];

for (let i = 0; i < vectors.length; i++) {
  for (let j = i + 1; j < vectors.length; j++) {
    const v1 = vectors[i].vector;
    const v2 = vectors[j].vector;
    let dot = 0;
    for (const [k, val] of Object.entries(v1)) {
      if (v2[k]) {
        dot += val * v2[k];
      }
    }
    pairwiseScores.push(Math.round(dot * 1000) / 1000);
  }
}
return { pairwiseScores };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const scores = inputs.pairwiseScores;
let sum = 0;
let maxSim = -1;
let minSim = 2;
let strongPairs = 0;

for (const s of scores) {
  sum += s;
  if (s > maxSim) maxSim = s;
  if (s < minSim) minSim = s;
  if (s >= 0.20) strongPairs++;
}

const avgSim = Math.round((sum / (scores.length || 1)) * 1000) / 1000;

return {
  totalComparisons: scores.length,
  averageSimilarity: avgSim,
  maxSimilarity: maxSim,
  minSimilarity: minSim,
  strongConnectionCount: strongPairs,
  corpusCohesive: avgSim > 0.05 && strongPairs >= 3,
};`,
        },
      ],
    },

    // 4. rb-designed-task-scheduling (8 cells)
    {
      name: "rb-designed-task-scheduling",
      heldoutSeedCode: `const tasks = [
  { id: 'H1', duration: 5, deps: [], priority: 2, ramMb: 1024 },
  { id: 'H2', duration: 3, deps: [], priority: 1, ramMb: 512 },
  { id: 'H3', duration: 7, deps: ['H1'], priority: 3, ramMb: 2048 },
  { id: 'H4', duration: 4, deps: ['H1', 'H2'], priority: 2, ramMb: 1024 },
  { id: 'H5', duration: 6, deps: ['H2'], priority: 1, ramMb: 512 },
  { id: 'H6', duration: 8, deps: ['H3'], priority: 3, ramMb: 4096 },
  { id: 'H7', duration: 5, deps: ['H3', 'H4'], priority: 2, ramMb: 1024 },
  { id: 'H8', duration: 3, deps: ['H4', 'H5'], priority: 1, ramMb: 512 },
  { id: 'H9', duration: 6, deps: ['H6'], priority: 3, ramMb: 2048 },
  { id: 'H10', duration: 4, deps: ['H7', 'H8'], priority: 2, ramMb: 1024 },
  { id: 'H11', duration: 5, deps: ['H9', 'H10'], priority: 3, ramMb: 2048 },
];
return { tasks };`,
      steps: [
        {
          id: randomUUID(),
          kind: "cell",
          code: `const tasks = [
  { id: 'T1', duration: 4, deps: [], priority: 1, ramMb: 512 },
  { id: 'T2', duration: 6, deps: ['T1'], priority: 2, ramMb: 1024 },
  { id: 'T3', duration: 3, deps: ['T1'], priority: 1, ramMb: 256 },
  { id: 'T4', duration: 8, deps: ['T2'], priority: 3, ramMb: 2048 },
  { id: 'T5', duration: 5, deps: ['T2', 'T3'], priority: 2, ramMb: 512 },
  { id: 'T6', duration: 2, deps: ['T3'], priority: 1, ramMb: 256 },
  { id: 'T7', duration: 7, deps: ['T4'], priority: 3, ramMb: 1024 },
  { id: 'T8', duration: 4, deps: ['T5', 'T6'], priority: 2, ramMb: 512 },
  { id: 'T9', duration: 5, deps: ['T7', 'T8'], priority: 3, ramMb: 1024 },
];
return { tasks };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const tasks = inputs.tasks;
const sorted = [...tasks].sort((a, b) => a.deps.length - b.deps.length || a.id.localeCompare(b.id));
return { sortedTasks: sorted };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const tasks = inputs.sortedTasks;
const finishTimes = {};
const forward = tasks.map((t) => {
  let estStart = 0;
  for (const d of t.deps) {
    if (finishTimes[d] && finishTimes[d] > estStart) {
      estStart = finishTimes[d];
    }
  }
  const estFinish = estStart + t.duration;
  finishTimes[t.id] = estFinish;
  return {
    ...t,
    estStart,
    estFinish,
  };
});
return { forwardSchedule: forward };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const forward = inputs.forwardSchedule;
const maxSpan = Math.max(...forward.map((t) => t.estFinish));
const latestStartMap = {};

for (let i = forward.length - 1; i >= 0; i--) {
  const t = forward[i];
  const dependents = forward.filter((f) => f.deps.includes(t.id));
  let lstFinish = maxSpan;
  if (dependents.length > 0) {
    lstFinish = Math.min(...dependents.map((d) => latestStartMap[d.id] ?? maxSpan));
  }
  const lstStart = lstFinish - t.duration;
  latestStartMap[t.id] = lstStart;
}

const bounded = forward.map((t) => ({
  ...t,
  lstStart: latestStartMap[t.id],
  slack: latestStartMap[t.id] - t.estStart,
}));
return { boundedSchedule: bounded };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const bounded = inputs.boundedSchedule;
const critical = bounded.map((t) => ({
  id: t.id,
  duration: t.duration,
  priority: t.priority,
  ramMb: t.ramMb,
  isCritical: t.slack === 0,
  estStart: t.estStart,
  estFinish: t.estFinish,
}));
return { criticalSchedule: critical };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const critical = inputs.criticalSchedule;
const allocated = critical.map((t) => {
  let workerSlot = 1;
  if (t.isCritical && t.priority >= 3) {
    workerSlot = 3;
  } else if (t.ramMb > 1024) {
    workerSlot = 2;
  }
  return {
    ...t,
    workerSlot,
  };
});
return { allocatedSchedule: allocated };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const allocated = inputs.allocatedSchedule;
const buffered = allocated.map((t) => {
  let bufferHours = 0;
  if (t.isCritical) {
    bufferHours = Math.ceil(t.duration * 0.20);
  }
  return {
    ...t,
    bufferedDuration: t.duration + bufferHours,
    bufferHours,
  };
});
return { bufferedSchedule: buffered };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const tasks = inputs.bufferedSchedule;
let totalWorkHours = 0;
let totalBuffer = 0;
let criticalCount = 0;
let maxFinish = 0;

for (const t of tasks) {
  totalWorkHours += t.duration;
  totalBuffer += t.bufferHours;
  if (t.isCritical) criticalCount++;
  const adjustedFinish = t.estFinish + t.bufferHours;
  if (adjustedFinish > maxFinish) maxFinish = adjustedFinish;
}

const efficiency = Math.round((totalWorkHours / (maxFinish || 1)) * 1000) / 10;

return {
  taskCount: tasks.length,
  criticalTaskCount: criticalCount,
  nominalMakespanHours: maxFinish,
  totalBufferHoursAllocated: totalBuffer,
  pipelineEfficiencyPct: efficiency,
  schedulingViable: maxFinish <= 60 && criticalCount >= 2,
};`,
        },
      ],
    },

    // 5. rb-designed-financial-reconciliation (8 cells)
    {
      name: "rb-designed-financial-reconciliation",
      heldoutSeedCode: `const ledgerRecords = [
  { ref: 'REF-H101', amount: 2400000, curr: 'IDR', fee: 0, date: '2026-08-10' },
  { ref: 'REF-H102', amount: 500, curr: 'USD', fee: 10, date: '2026-08-10' },
  { ref: 'REF-H103', amount: 350, curr: 'EUR', fee: 6, date: '2026-08-11' },
  { ref: 'REF-H104', amount: 6800000, curr: 'IDR', fee: 0, date: '2026-08-11' },
  { ref: 'REF-H105', amount: 120, curr: 'USD', fee: 3, date: '2026-08-12' },
  { ref: 'REF-H106', amount: 4500000, curr: 'IDR', fee: 0, date: '2026-08-12' },
  { ref: 'REF-H107', amount: 800, curr: 'EUR', fee: 12, date: '2026-08-13' },
  { ref: 'REF-H108', amount: 950000, curr: 'IDR', fee: 0, date: '2026-08-13' },
  { ref: 'REF-H109', amount: 650, curr: 'USD', fee: 12, date: '2026-08-14' },
  { ref: 'REF-H110', amount: 11000000, curr: 'IDR', fee: 0, date: '2026-08-14' },
];

const gatewayRecords = [
  { ref: 'REF-H101', netPaid: 2352000, gatewayFee: 48000, curr: 'IDR' },
  { ref: 'REF-H102', netPaid: 490, gatewayFee: 10, curr: 'USD' },
  { ref: 'REF-H103', netPaid: 343, gatewayFee: 7, curr: 'EUR' },
  { ref: 'REF-H104', netPaid: 6664000, gatewayFee: 136000, curr: 'IDR' },
  { ref: 'REF-H105', netPaid: 117.6, gatewayFee: 2.4, curr: 'USD' },
  { ref: 'REF-H106', netPaid: 4410000, gatewayFee: 90000, curr: 'IDR' },
  { ref: 'REF-H107', netPaid: 784, gatewayFee: 16, curr: 'EUR' },
  { ref: 'REF-H108', netPaid: 931000, gatewayFee: 19000, curr: 'IDR' },
  { ref: 'REF-H109', netPaid: 637, gatewayFee: 13, curr: 'USD' },
  { ref: 'REF-H110', netPaid: 10780000, gatewayFee: 220000, curr: 'IDR' },
];
return { ledgerRecords, gatewayRecords };`,
      steps: [
        {
          id: randomUUID(),
          kind: "cell",
          code: `const ledgerRecords = [
  { ref: 'REF-001', amount: 1500000, curr: 'IDR', fee: 0, date: '2026-08-01' },
  { ref: 'REF-002', amount: 250, curr: 'USD', fee: 5, date: '2026-08-01' },
  { ref: 'REF-003', amount: 3200000, curr: 'IDR', fee: 0, date: '2026-08-02' },
  { ref: 'REF-004', amount: 180, curr: 'EUR', fee: 3, date: '2026-08-02' },
  { ref: 'REF-005', amount: 500000, curr: 'IDR', fee: 0, date: '2026-08-03' },
  { ref: 'REF-006', amount: 420, curr: 'USD', fee: 8, date: '2026-08-03' },
  { ref: 'REF-007', amount: 8500000, curr: 'IDR', fee: 0, date: '2026-08-04' },
  { ref: 'REF-008', amount: 95, curr: 'USD', fee: 2, date: '2026-08-04' },
];

const gatewayRecords = [
  { ref: 'REF-001', netPaid: 1470000, gatewayFee: 30000, curr: 'IDR' },
  { ref: 'REF-002', netPaid: 245, gatewayFee: 5, curr: 'USD' },
  { ref: 'REF-003', netPaid: 3136000, gatewayFee: 64000, curr: 'IDR' },
  { ref: 'REF-004', netPaid: 176.4, gatewayFee: 3.6, curr: 'EUR' },
  { ref: 'REF-005', netPaid: 490000, gatewayFee: 10000, curr: 'IDR' },
  { ref: 'REF-006', netPaid: 411.6, gatewayFee: 8.4, curr: 'USD' },
  { ref: 'REF-007', netPaid: 8330000, gatewayFee: 170000, curr: 'IDR' },
  { ref: 'REF-008', netPaid: 93.1, gatewayFee: 1.9, curr: 'USD' },
];
return { ledgerRecords, gatewayRecords };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const FX_RATES = { IDR: 1, USD: 16000, EUR: 17500 };
const normalizedLedger = inputs.ledgerRecords.map((l) => {
  const rate = FX_RATES[l.curr] || 1;
  const baseAmt = l.amount * rate;
  return {
    ref: l.ref,
    baseAmountIdr: Math.round(baseAmt),
  };
});
const normalizedGateway = inputs.gatewayRecords.map((g) => {
  const rate = FX_RATES[g.curr] || 1;
  const baseNet = g.netPaid * rate;
  const baseFee = g.gatewayFee * rate;
  return {
    ref: g.ref,
    baseNetIdr: Math.round(baseNet),
    baseFeeIdr: Math.round(baseFee),
  };
});
return { normalizedLedger, normalizedGateway };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const { normalizedLedger, normalizedGateway } = inputs;
const gwMap = {};
for (const g of normalizedGateway) gwMap[g.ref] = g;

const matchedPairs = normalizedLedger.map((l) => {
  const g = gwMap[l.ref];
  const matched = !!g;
  const grossDiff = matched ? l.baseAmountIdr - (g.baseNetIdr + g.baseFeeIdr) : l.baseAmountIdr;
  return {
    ref: l.ref,
    ledgerGross: l.baseAmountIdr,
    gatewayNet: g ? g.baseNetIdr : 0,
    gatewayFee: g ? g.baseFeeIdr : 0,
    grossDiff: Math.abs(grossDiff),
  };
});
return { matchedPairs };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const audited = inputs.matchedPairs.map((p) => {
  const feePct = (p.gatewayFee / (p.ledgerGross || 1)) * 100;
  const compliant = feePct <= 2.5;
  return {
    ...p,
    feePct: Math.round(feePct * 100) / 100,
    isCompliant: compliant,
  };
});
return { auditedBatches: audited };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const withHolds = inputs.auditedBatches.map((b) => {
  let holdbackAmount = 0;
  if (!b.isCompliant || b.grossDiff > 500) {
    holdbackAmount = Math.round(b.ledgerGross * 0.10);
  }
  return {
    ...b,
    holdbackAmount,
  };
});
return { holdbackBatches: withHolds };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const taxed = inputs.holdbackBatches.map((h) => {
  const pph23OnFee = Math.round(h.gatewayFee * 0.02);
  return {
    ...h,
    pph23Withholding: pph23OnFee,
  };
});
return { taxedSettlement: taxed };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const cleared = inputs.taxedSettlement.map((t) => {
  const netClearing = t.gatewayNet - t.holdbackAmount + t.pph23Withholding;
  return {
    ref: t.ref,
    netClearing,
    grossDiff: t.grossDiff,
    isCompliant: t.isCompliant,
  };
});
return { clearedRecords: cleared };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const records = inputs.clearedRecords;
let totalGrossCleared = 0;
let totalDiff = 0;
let compliantCount = 0;

for (const r of records) {
  totalGrossCleared += r.netClearing;
  totalDiff += r.grossDiff;
  if (r.isCompliant) compliantCount++;
}

const matchRate = Math.round((compliantCount / (records.length || 1)) * 1000) / 10;

return {
  recordsProcessed: records.length,
  totalNetClearedIdr: Math.round(totalGrossCleared),
  discrepancyIdr: Math.round(totalDiff),
  complianceRatePct: matchRate,
  reconciliationPassed: totalDiff === 0 && matchRate >= 80,
};`,
        },
      ],
    },

    // 6. rb-designed-credit-scoring (9 cells)
    {
      name: "rb-designed-credit-scoring",
      heldoutSeedCode: `const bureauProfiles = [
  { id: 'BOR-H201', age: 38, jobTenureYears: 7, inquiries6m: 1, utilPct: 25, late30d: 0, lines: 5 },
  { id: 'BOR-H202', age: 24, jobTenureYears: 2, inquiries6m: 4, utilPct: 85, late30d: 2, lines: 3 },
  { id: 'BOR-H203', age: 49, jobTenureYears: 14, inquiries6m: 0, utilPct: 18, late30d: 0, lines: 7 },
  { id: 'BOR-H204', age: 32, jobTenureYears: 5, inquiries6m: 2, utilPct: 45, late30d: 1, lines: 4 },
  { id: 'BOR-H205', age: 62, jobTenureYears: 24, inquiries6m: 0, utilPct: 8, late30d: 0, lines: 9 },
  { id: 'BOR-H206', age: 27, jobTenureYears: 3, inquiries6m: 3, utilPct: 70, late30d: 1, lines: 2 },
  { id: 'BOR-H207', age: 44, jobTenureYears: 10, inquiries6m: 1, utilPct: 32, late30d: 0, lines: 6 },
  { id: 'BOR-H208', age: 56, jobTenureYears: 18, inquiries6m: 0, utilPct: 12, late30d: 0, lines: 8 },
  { id: 'BOR-H209', age: 30, jobTenureYears: 4, inquiries6m: 2, utilPct: 58, late30d: 1, lines: 3 },
  { id: 'BOR-H210', age: 41, jobTenureYears: 8, inquiries6m: 0, utilPct: 29, late30d: 0, lines: 5 },
  { id: 'BOR-H211', age: 23, jobTenureYears: 1, inquiries6m: 5, utilPct: 92, late30d: 3, lines: 2 },
  { id: 'BOR-H212', age: 35, jobTenureYears: 6, inquiries6m: 1, utilPct: 38, late30d: 0, lines: 4 },
];
return { bureauProfiles };`,
      steps: [
        {
          id: randomUUID(),
          kind: "cell",
          code: `const bureauProfiles = [
  { id: 'BOR-101', age: 42, jobTenureYears: 9, inquiries6m: 0, utilPct: 22, late30d: 0, lines: 4 },
  { id: 'BOR-102', age: 25, jobTenureYears: 1, inquiries6m: 3, utilPct: 82, late30d: 2, lines: 2 },
  { id: 'BOR-103', age: 36, jobTenureYears: 6, inquiries6m: 1, utilPct: 35, late30d: 0, lines: 5 },
  { id: 'BOR-104', age: 51, jobTenureYears: 15, inquiries6m: 0, utilPct: 15, late30d: 0, lines: 8 },
  { id: 'BOR-105', age: 29, jobTenureYears: 3, inquiries6m: 2, utilPct: 65, late30d: 1, lines: 3 },
  { id: 'BOR-106', age: 47, jobTenureYears: 11, inquiries6m: 1, utilPct: 40, late30d: 0, lines: 6 },
  { id: 'BOR-107', age: 31, jobTenureYears: 4, inquiries6m: 4, utilPct: 89, late30d: 3, lines: 4 },
  { id: 'BOR-108', age: 39, jobTenureYears: 8, inquiries6m: 0, utilPct: 28, late30d: 0, lines: 5 },
  { id: 'BOR-109', age: 28, jobTenureYears: 2, inquiries6m: 2, utilPct: 55, late30d: 1, lines: 2 },
  { id: 'BOR-110', age: 58, jobTenureYears: 20, inquiries6m: 0, utilPct: 10, late30d: 0, lines: 7 },
];
return { bureauProfiles };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const binned = inputs.bureauProfiles.map((p) => {
  const ageBin = p.age < 30 ? 'YOUNG' : p.age < 50 ? 'MID' : 'SENIOR';
  const utilBin = p.utilPct < 30 ? 'LOW' : p.utilPct < 60 ? 'MED' : 'HIGH';
  const inqBin = p.inquiries6m === 0 ? 'ZERO' : p.inquiries6m <= 2 ? 'FEW' : 'MANY';
  return {
    ...p,
    ageBin,
    utilBin,
    inqBin,
  };
});
return { binnedProfiles: binned };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const WOE_TABLE = {
  ageBin: { YOUNG: -0.35, MID: 0.20, SENIOR: 0.45 },
  utilBin: { LOW: 0.65, MED: 0.10, HIGH: -0.80 },
  inqBin: { ZERO: 0.40, FEW: -0.15, MANY: -0.75 },
};

const transformed = inputs.binnedProfiles.map((p) => {
  const wAge = WOE_TABLE.ageBin[p.ageBin] || 0;
  const wUtil = WOE_TABLE.utilBin[p.utilBin] || 0;
  const wInq = WOE_TABLE.inqBin[p.inqBin] || 0;
  const wLate = p.late30d === 0 ? 0.50 : p.late30d === 1 ? -0.30 : -1.10;
  return {
    id: p.id,
    wAge,
    wUtil,
    wInq,
    wLate,
    lines: p.lines,
  };
});
return { woeProfiles: transformed };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const withLogits = inputs.woeProfiles.map((p) => {
  const logit = 0.5 + (p.wAge * 0.8) + (p.wUtil * 1.4) + (p.wInq * 0.9) + (p.wLate * 1.6) + (p.lines * 0.05);
  return {
    id: p.id,
    logit: Math.round(logit * 1000) / 1000,
  };
});
return { logitProfiles: withLogits };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `// Scale logit to standard credit score (PDO = 20, Target 600 at logit 0)
const scaled = inputs.logitProfiles.map((p) => {
  const score = 600 + (p.logit * 28.85);
  let finalScore = Math.round(score);
  if (finalScore > 850) finalScore = 850;
  if (finalScore < 300) finalScore = 300;
  return {
    id: p.id,
    creditScore: finalScore,
  };
});
return { creditScores: scaled };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const tiered = inputs.creditScores.map((s) => {
  let tier = 'SUBPRIME';
  let maxLimit = 5000;
  if (s.creditScore >= 740) {
    tier = 'PRIME';
    maxLimit = 50000;
  } else if (s.creditScore >= 670) {
    tier = 'NEAR_PRIME';
    maxLimit = 25000;
  } else if (s.creditScore >= 580) {
    tier = 'ACCEPTABLE';
    maxLimit = 12000;
  }
  return {
    ...s,
    tier,
    maxLimit,
  };
});
return { tieredDecisions: tiered };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const priced = inputs.tieredDecisions.map((d) => {
  const baseRate = 0.075;
  const spread = d.tier === 'PRIME' ? 0.02 : d.tier === 'NEAR_PRIME' ? 0.045 : d.tier === 'ACCEPTABLE' ? 0.08 : 0.14;
  return {
    ...d,
    offeredApr: Math.round((baseRate + spread) * 1000) / 10,
    approved: d.tier !== 'SUBPRIME',
  };
});
return { portfolioPricing: priced };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const allocatedCapital = inputs.portfolioPricing.map((p) => {
  const reserveRatio = p.tier === 'PRIME' ? 0.05 : p.tier === 'NEAR_PRIME' ? 0.10 : 0.20;
  const requiredCapitalReserve = Math.round(p.maxLimit * reserveRatio);
  return {
    ...p,
    requiredCapitalReserve,
  };
});
return { allocatedCapital };`,
        },
        {
          id: randomUUID(),
          kind: "cell",
          code: `const items = inputs.allocatedCapital;
let sumScore = 0;
let approvedCount = 0;
let totalLimit = 0;
let sumApr = 0;
let totalReserves = 0;

for (const it of items) {
  sumScore += it.creditScore;
  if (it.approved) {
    approvedCount++;
    totalLimit += it.maxLimit;
    sumApr += it.offeredApr;
    totalReserves += it.requiredCapitalReserve;
  }
}

const avgScore = Math.round(sumScore / (items.length || 1));
const avgApr = approvedCount > 0 ? Math.round((sumApr / approvedCount) * 10) / 10 : 0;

return {
  totalProfiles: items.length,
  averageCreditScore: avgScore,
  approvedCount,
  totalCreditLimitAssigned: totalLimit,
  totalCapitalReservesCommitted: totalReserves,
  averageApprovedAprPct: avgApr,
  portfolioAcceptable: avgScore >= 600 && approvedCount >= 4,
};`,
        },
      ],
    },
  ];
}

async function main() {
  console.log("=======================================================");
  console.log("R10.1 & R7.0 — PROVISIONING DESIGNED NOTEBOOKS & HELDOUT TRUTH");
  console.log("=======================================================");

  const fixturesDir = join(process.cwd(), "fixtures", "designed");
  mkdirSync(fixturesDir, { recursive: true });

  const existing = await listNotebooks();
  const existingMap = new Map(existing.map((n) => [n.name, n.id]));

  const definitions = createDesignedNotebookDefinitions();

  for (let idx = 0; idx < definitions.length; idx++) {
    const nbDef = definitions[idx];
    console.log(`\n[${idx + 1}/6] Provisioning ${nbDef.name} (${nbDef.steps.length} cells with UUID IDs)...`);

    let nbId = existingMap.get(nbDef.name);
    let doc: any;

    if (nbId) {
      console.log(`  Updating existing notebook ${nbDef.name} (${nbId})...`);
      doc = { ...nbDef, id: nbId };
      await saveNotebookDoc(doc);
    } else {
      console.log(`  Creating new notebook ${nbDef.name}...`);
      const created = await saveNotebookDoc(nbDef);
      nbId = created.id;
      doc = created;
    }

    // Verify 10x determinism replays on primary seed
    console.log(`  Verifying 10 replay runs for primary determinism...`);
    const baselineRun = await runNotebook(nbId);
    if (baselineRun.status !== "success") {
      throw new Error(`Baseline run failed for ${nbDef.name}: ${baselineRun.error}`);
    }

    const baselineTerminalId = nbDef.steps[nbDef.steps.length - 1].id;
    const baselineOutput = baselineRun.cell_results?.[baselineTerminalId]?.output;
    const baselineHash = hashValue(baselineOutput);

    for (let r = 1; r <= 10; r++) {
      const replayRun = await runNotebook(nbId);
      const replayOutput = replayRun.cell_results?.[baselineTerminalId]?.output;
      const replayHash = hashValue(replayOutput);
      if (replayHash !== baselineHash) {
        throw new Error(`Non-deterministic output on replay ${r} for ${nbDef.name}!`);
      }
    }
    console.log(`  ✓ 10/10 Replays strictly deterministic! Primary output hash: ${baselineHash.slice(0, 12)}...`);

    // Compute heldOutTruthHash on pre-mutation notebook
    console.log(`  Computing heldOutTruthHash using held-out seed...`);
    const scratchDup = await duplicateNotebook(nbId);
    const scratchId = scratchDup.id;
    const uuid8 = randomUUID().slice(0, 8);
    const scratchName = `zz-rewind-scratch-${uuid8}`;
    let heldOutTruthHash = "";

    try {
      const scratchDoc = { ...doc, id: scratchId, name: scratchName };
      scratchDoc.steps[0].code = nbDef.heldoutSeedCode;
      await saveNotebookDoc(scratchDoc);

      const heldoutRun = await runNotebook(scratchId);
      if (heldoutRun.status !== "success") {
        throw new Error(`Held-out run failed for ${nbDef.name}: ${heldoutRun.error}`);
      }

      const heldoutOutput = heldoutRun.cell_results?.[baselineTerminalId]?.output;
      heldOutTruthHash = hashValue(heldoutOutput);
      console.log(`  ✓ Held-out truth output hash computed: ${heldOutTruthHash.slice(0, 12)}...`);
    } finally {
      await deleteNotebook(scratchId, scratchName);
    }

    // Save primary fixture JSON with heldOutTruthHash metadata
    const fixturePrimary = {
      ...doc,
      heldOutTruthHash,
    };
    const fixturePath = join(fixturesDir, `${nbDef.name}.json`);
    writeFileSync(fixturePath, JSON.stringify(fixturePrimary, null, 2), "utf8");
    console.log(`  ✓ Saved primary fixture to ${fixturePath}`);

    // Save held-out fixture JSON
    const fixtureHeldout = {
      ...doc,
      heldOutTruthHash,
      steps: doc.steps.map((s: any, sIdx: number) => {
        if (sIdx === 0) {
          return { ...s, code: nbDef.heldoutSeedCode };
        }
        return s;
      }),
    };
    const heldoutFixturePath = join(fixturesDir, `${nbDef.name}.heldout.json`);
    writeFileSync(heldoutFixturePath, JSON.stringify(fixtureHeldout, null, 2), "utf8");
    console.log(`  ✓ Saved held-out fixture to ${heldoutFixturePath}`);
  }

  console.log("\n" + "=".repeat(65));
  console.log("ALL 6 DESIGNED NOTEBOOKS & HELDOUT FIXTURES GENERATED");
  console.log("Fixtures: fixtures/designed/*.json & *.heldout.json");
  console.log("=".repeat(65));
}

main().catch((err) => {
  console.error("Failed to provision designed notebooks:", err);
  process.exit(1);
});
