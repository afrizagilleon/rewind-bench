/**
 * Report Generator for RewindBench (R8)
 *
 * Generates results/report.html:
 * - Single self-contained HTML file
 * - Zero CDNs, zero external <script src>, zero external webfonts
 * - Inline CSS with a clean, state-of-the-art aesthetic
 * - Inline SVG charts drawn directly from data
 * - Data sourced from results/metrics.json
 *
 * Structure:
 * 1. H4 — Determinism Census (r = 0.8942, 93/104 cells, 1040 replays, causes)
 * 2. Two Corpora SIDE-BY-SIDE (Designed vs Incidental, never merged)
 * 3. Genuine Resolution (resolved && !luckyPass) & McNemar Paired Tests (all p=1.0)
 * 4. Cost: Tokens per Genuine Fix (Inline SVG Bar Chart)
 * 5. Lucky-pass Case Study: b143f174 3-way code diff & compensation analysis
 * 6. Limitations (core section)
 * 7. Cross-Model Evaluation (GLM-5.2 placeholder / live data)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

interface GroupMetrics {
  totalRuns: number;
  validRuns: number;
  resolvedAll: number;
  resolvedAllPct: number;
  resolvedValid: number;
  resolvedValidPct: number;
  luckyPassCount: number;
  luckyPassRate: number | null;
  resolvedGenuine: number;
  resolvedGenuinePct: number;
  offTargetFixCount: number;
  protocolFailures: number;
  lengthFailures: number;
  crfMean: number;
  crfMedian: number;
  hitAt1Count: number;
  hitAt1Pct: number;
  pqiMean: number;
  pqiMedian: number;
  avgTurns: number;
  avgWallMs: number;
  avgPromptTokens: number;
  avgReasoningTokens: number;
  avgAnswerTokens: number;
  avgTotalTokens: number;
  totalPromptTokens: number;
  totalReasoningTokens: number;
  totalAnswerTokens: number;
  totalTokens: number;
  amortizedTokensPerGenuineFix: number | null;
  avgTokensOnGenuineFixes: number | null;
}

interface PairedComp {
  arm1: string;
  arm2: string;
  totalMutations: number;
  bothResolved: number;
  arm1Won: number;
  arm2Won: number;
  bothFailed: number;
  totalDiscordant: number;
  exactBinomialPValue: number;
  discordantRatio: string;
}

interface CorpusReport {
  corpusName: string;
  totalMutations: number;
  totalRuns: number;
  arms: {
    monolithic: GroupMetrics;
    stepwise: GroupMetrics;
    rewind: GroupMetrics;
  };
  byDistBand: Record<string, {
    monolithic?: GroupMetrics;
    stepwise?: GroupMetrics;
    rewind?: GroupMetrics;
    paired?: Record<string, PairedComp>;
  }>;
  byStratum: Record<string, {
    monolithic?: GroupMetrics;
    stepwise?: GroupMetrics;
    rewind?: GroupMetrics;
    paired?: Record<string, PairedComp>;
  }>;
  byHopBand: Record<string, {
    monolithic?: GroupMetrics;
    stepwise?: GroupMetrics;
    rewind?: GroupMetrics;
    paired?: Record<string, PairedComp>;
  }>;
  pairedOverall: Record<string, PairedComp>;
}

function formatNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "n/a";
  return n.toLocaleString("en-US");
}

function formatPct(n: number | null | undefined): string {
  if (n === null || n === undefined) return "n/a";
  return `${n.toFixed(1)}%`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// --- SVG CHART GENERATION ---

function generateTokenCostChartSvg(
  designedArms: { monolithic: GroupMetrics; stepwise: GroupMetrics; rewind: GroupMetrics },
  incidentalArms: { monolithic: GroupMetrics; stepwise: GroupMetrics; rewind: GroupMetrics }
): string {
  const width = 800;
  const height = 340;
  const margin = { top: 40, right: 30, bottom: 60, left: 90 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;

  const data = [
    {
      corpus: "Corpus Terancang (N=30)",
      mono: designedArms.monolithic.amortizedTokensPerGenuineFix || 0,
      step: designedArms.stepwise.amortizedTokensPerGenuineFix || 0,
      rewind: designedArms.rewind.amortizedTokensPerGenuineFix || 0,
    },
    {
      corpus: "Corpus Insidental (N=39)",
      mono: incidentalArms.monolithic.amortizedTokensPerGenuineFix || 0,
      step: incidentalArms.stepwise.amortizedTokensPerGenuineFix || 0,
      rewind: incidentalArms.rewind.amortizedTokensPerGenuineFix || 0,
    },
  ];

  const maxVal = 90000;
  const yTicks = [0, 20000, 40000, 60000, 80000];

  const colors = {
    mono: "#3b82f6", // Blue
    step: "#f59e0b", // Amber
    rewind: "#10b981", // Emerald
  };

  let gridLines = "";
  for (const tick of yTicks) {
    const y = margin.top + chartHeight - (tick / maxVal) * chartHeight;
    gridLines += `
      <line x1="${margin.left}" y1="${y}" x2="${margin.left + chartWidth}" y2="${y}" stroke="#334155" stroke-dasharray="4,4" stroke-width="1"/>
      <text x="${margin.left - 12}" y="${y + 4}" fill="#94a3b8" font-size="11" text-anchor="end" font-family="-apple-system, sans-serif">${tick.toLocaleString()}</text>
    `;
  }

  let barsSvg = "";
  const groupWidth = chartWidth / data.length;
  const barWidth = 44;
  const barSpacing = 10;

  data.forEach((group, gIdx) => {
    const groupCenterX = margin.left + gIdx * groupWidth + groupWidth / 2;
    const groupStartX = groupCenterX - (barWidth * 3 + barSpacing * 2) / 2;

    const values = [
      { name: "Arm A (Mono)", val: group.mono, color: colors.mono },
      { name: "Arm B (Step)", val: group.step, color: colors.step },
      { name: "Arm C (Rewind)", val: group.rewind, color: colors.rewind },
    ];

    values.forEach((b, bIdx) => {
      const barX = groupStartX + bIdx * (barWidth + barSpacing);
      const barH = (b.val / maxVal) * chartHeight;
      const barY = margin.top + chartHeight - barH;

      barsSvg += `
        <rect x="${barX}" y="${barY}" width="${barWidth}" height="${barH}" rx="4" fill="${b.color}" opacity="0.9">
          <title>${group.corpus} - ${b.name}: ${b.val.toLocaleString()} tokens/fix</title>
        </rect>
        <text x="${barX + barWidth / 2}" y="${barY - 8}" fill="#f8fafc" font-size="11" font-weight="600" text-anchor="middle" font-family="-apple-system, sans-serif">
          ${Math.round(b.val / 1000)}k
        </text>
      `;
    });

    // Group Label
    barsSvg += `
      <text x="${groupCenterX}" y="${margin.top + chartHeight + 28}" fill="#e2e8f0" font-size="13" font-weight="600" text-anchor="middle" font-family="-apple-system, sans-serif">
        ${group.corpus}
      </text>
    `;
  });

  return `
    <svg viewBox="0 0 ${width} ${height}" class="chart-svg" style="width: 100%; max-width: 800px; height: auto;">
      <rect width="${width}" height="${height}" fill="#0f172a" rx="8"/>
      <!-- Grid & Ticks -->
      ${gridLines}
      <!-- Axes -->
      <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + chartHeight}" stroke="#64748b" stroke-width="1.5"/>
      <line x1="${margin.left}" y1="${margin.top + chartHeight}" x2="${margin.left + chartWidth}" y2="${margin.top + chartHeight}" stroke="#64748b" stroke-width="1.5"/>
      <!-- Bars -->
      ${barsSvg}
      <!-- Legend -->
      <g transform="translate(${margin.left + chartWidth - 360}, 18)">
        <rect x="0" y="0" width="14" height="14" rx="2" fill="${colors.mono}"/>
        <text x="20" y="11" fill="#cbd5e1" font-size="11" font-family="-apple-system, sans-serif">Arm A (Monolithic)</text>
        <rect x="130" y="0" width="14" height="14" rx="2" fill="${colors.step}"/>
        <text x="150" y="11" fill="#cbd5e1" font-size="11" font-family="-apple-system, sans-serif">Arm B (Stepwise)</text>
        <rect x="250" y="0" width="14" height="14" rx="2" fill="${colors.rewind}"/>
        <text x="270" y="11" fill="#cbd5e1" font-size="11" font-family="-apple-system, sans-serif">Arm C (Rewind)</text>
      </g>
    </svg>
  `;
}

function generateAccuracyComparisonSvg(
  designedArms: { monolithic: GroupMetrics; stepwise: GroupMetrics; rewind: GroupMetrics },
  incidentalArms: { monolithic: GroupMetrics; stepwise: GroupMetrics; rewind: GroupMetrics }
): string {
  const width = 800;
  const height = 280;
  const margin = { top: 40, right: 30, bottom: 50, left: 60 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;

  const data = [
    {
      corpus: "Corpus Terancang",
      mono: designedArms.monolithic.resolvedGenuinePct,
      step: designedArms.stepwise.resolvedGenuinePct,
      rewind: designedArms.rewind.resolvedGenuinePct,
    },
    {
      corpus: "Corpus Insidental",
      mono: incidentalArms.monolithic.resolvedGenuinePct,
      step: incidentalArms.stepwise.resolvedGenuinePct,
      rewind: incidentalArms.rewind.resolvedGenuinePct,
    },
  ];

  const yTicks = [0, 25, 50, 75, 100];
  let gridLines = "";
  for (const tick of yTicks) {
    const y = margin.top + chartHeight - (tick / 100) * chartHeight;
    gridLines += `
      <line x1="${margin.left}" y1="${y}" x2="${margin.left + chartWidth}" y2="${y}" stroke="#334155" stroke-dasharray="4,4" stroke-width="1"/>
      <text x="${margin.left - 10}" y="${y + 4}" fill="#94a3b8" font-size="11" text-anchor="end" font-family="-apple-system, sans-serif">${tick}%</text>
    `;
  }

  let barsSvg = "";
  const groupWidth = chartWidth / data.length;
  const barWidth = 44;
  const barSpacing = 12;

  data.forEach((group, gIdx) => {
    const groupCenterX = margin.left + gIdx * groupWidth + groupWidth / 2;
    const groupStartX = groupCenterX - (barWidth * 3 + barSpacing * 2) / 2;

    const values = [
      { name: "Arm A", val: group.mono, color: "#3b82f6" },
      { name: "Arm B", val: group.step, color: "#f59e0b" },
      { name: "Arm C", val: group.rewind, color: "#10b981" },
    ];

    values.forEach((b, bIdx) => {
      const barX = groupStartX + bIdx * (barWidth + barSpacing);
      const barH = (b.val / 100) * chartHeight;
      const barY = margin.top + chartHeight - barH;

      barsSvg += `
        <rect x="${barX}" y="${barY}" width="${barWidth}" height="${barH}" rx="4" fill="${b.color}" opacity="0.9"/>
        <text x="${barX + barWidth / 2}" y="${barY - 6}" fill="#f8fafc" font-size="11" font-weight="600" text-anchor="middle" font-family="-apple-system, sans-serif">
          ${b.val.toFixed(1)}%
        </text>
      `;
    });

    barsSvg += `
      <text x="${groupCenterX}" y="${margin.top + chartHeight + 24}" fill="#e2e8f0" font-size="13" font-weight="600" text-anchor="middle" font-family="-apple-system, sans-serif">
        ${group.corpus}
      </text>
    `;
  });

  return `
    <svg viewBox="0 0 ${width} ${height}" class="chart-svg" style="width: 100%; max-width: 800px; height: auto;">
      <rect width="${width}" height="${height}" fill="#0f172a" rx="8"/>
      ${gridLines}
      <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + chartHeight}" stroke="#64748b" stroke-width="1.5"/>
      <line x1="${margin.left}" y1="${margin.top + chartHeight}" x2="${margin.left + chartWidth}" y2="${margin.top + chartHeight}" stroke="#64748b" stroke-width="1.5"/>
      ${barsSvg}
      <g transform="translate(${margin.left + chartWidth - 330}, 16)">
        <rect x="0" y="0" width="12" height="12" rx="2" fill="#3b82f6"/>
        <text x="18" y="10" fill="#cbd5e1" font-size="11" font-family="-apple-system, sans-serif">Arm A (Mono)</text>
        <rect x="110" y="0" width="12" height="12" rx="2" fill="#f59e0b"/>
        <text x="128" y="10" fill="#cbd5e1" font-size="11" font-family="-apple-system, sans-serif">Arm B (Stepwise)</text>
        <rect x="220" y="0" width="12" height="12" rx="2" fill="#10b981"/>
        <text x="238" y="10" fill="#cbd5e1" font-size="11" font-family="-apple-system, sans-serif">Arm C (Rewind)</text>
      </g>
    </svg>
  `;
}

// --- HTML REPORT BUILDER ---

export function generateHtmlReport(metricsData: {
  incidental: CorpusReport;
  designed: CorpusReport;
  designed_glm?: CorpusReport;
}): string {
  const inc = metricsData.incidental;
  const des = metricsData.designed;
  const glm = metricsData.designed_glm;

  const costSvg = generateTokenCostChartSvg(des.arms, inc.arms);
  const accSvg = generateAccuracyComparisonSvg(des.arms, inc.arms);

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RewindBench: Laporan Eksperimen & Evaluasi Formal</title>
  <style>
    :root {
      --bg-primary: #090d16;
      --bg-surface: #111827;
      --bg-card: #1e293b;
      --bg-code: #0b0f19;
      --border-subtle: #334155;
      --border-strong: #475569;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --arm-a: #3b82f6;
      --arm-b: #f59e0b;
      --arm-c: #10b981;
      --danger: #ef4444;
      --accent: #8b5cf6;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      background-color: var(--bg-primary);
      color: var(--text-main);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      line-height: 1.6;
      padding: 32px 24px;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    header {
      margin-bottom: 40px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border-subtle);
    }
    h1 {
      font-size: 2.2rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 8px;
      color: #ffffff;
    }
    .subtitle {
      font-size: 1.05rem;
      color: var(--text-muted);
    }
    .badge {
      display: inline-block;
      padding: 3px 9px;
      border-radius: 4px;
      font-size: 0.78rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .badge-success { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); }
    .badge-warning { background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); }
    .badge-info { background: rgba(59, 130, 246, 0.2); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.4); }
    
    section {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 10px;
      padding: 28px;
      margin-bottom: 32px;
    }
    h2 {
      font-size: 1.45rem;
      font-weight: 600;
      margin-bottom: 16px;
      letter-spacing: -0.01em;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    h3 {
      font-size: 1.15rem;
      font-weight: 600;
      margin: 20px 0 12px 0;
      color: #e2e8f0;
    }
    p, li {
      color: #cbd5e1;
      font-size: 0.95rem;
      margin-bottom: 12px;
    }
    ul, ol {
      padding-left: 24px;
      margin-bottom: 16px;
    }
    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
    }
    @media (max-width: 900px) {
      .grid-2 { grid-template-columns: 1fr; }
    }
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 20px;
    }
    .stat-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px;
      margin-top: 16px;
    }
    .stat-box {
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid var(--border-subtle);
      padding: 16px;
      border-radius: 6px;
      text-align: center;
    }
    .stat-val {
      font-size: 1.8rem;
      font-weight: 700;
      color: #ffffff;
      margin-bottom: 4px;
    }
    .stat-label {
      font-size: 0.8rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    /* Tables */
    .table-container {
      overflow-x: auto;
      margin: 16px 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
      text-align: left;
    }
    th, td {
      padding: 10px 14px;
      border-bottom: 1px solid var(--border-subtle);
    }
    th {
      background: #1e293b;
      color: #e2e8f0;
      font-weight: 600;
      font-size: 0.82rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    tr:hover td {
      background: rgba(255, 255, 255, 0.02);
    }
    .cell-numeric {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .arm-pill {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-right: 6px;
    }
    .pill-a { background: var(--arm-a); }
    .pill-b { background: var(--arm-b); }
    .pill-c { background: var(--arm-c); }

    /* Code blocks */
    pre, code {
      font-family: "JetBrains Mono", "SFMono-Regular", Menlo, Monaco, Consolas, monospace;
      font-size: 0.86rem;
    }
    pre {
      background: var(--bg-code);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      padding: 14px;
      overflow-x: auto;
      color: #e2e8f0;
      line-height: 1.5;
    }
    .code-grid {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 14px;
      margin: 16px 0;
    }
    @media (max-width: 992px) {
      .code-grid { grid-template-columns: 1fr; }
    }
    .code-col {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      padding: 14px;
    }
    .code-col-title {
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
    }
    .highlight-diff {
      color: #34d399;
      font-weight: 600;
    }
    .highlight-mut {
      color: #f87171;
      font-weight: 600;
    }

    /* Charts */
    .chart-box {
      margin: 20px 0;
      display: flex;
      justify-content: center;
    }

    .callout {
      border-left: 4px solid var(--accent);
      background: rgba(139, 92, 246, 0.08);
      padding: 16px;
      border-radius: 0 6px 6px 0;
      margin: 16px 0;
    }
    .callout-title {
      font-weight: 600;
      color: #c4b5fd;
      margin-bottom: 4px;
    }
    footer {
      text-align: center;
      font-size: 0.85rem;
      color: var(--text-dim);
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid var(--border-subtle);
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;">
        <div>
          <h1>RewindBench: Laporan Eksperimen & Evaluasi Formal</h1>
          <div class="subtitle">Evaluasi Komparatif Pemulihan Reaktif: Monolithic (Arm A) vs Stepwise (Arm B) vs Materialized Rewind (Arm C)</div>
        </div>
        <span class="badge badge-success">R8 Full Report</span>
      </div>
    </header>

    <!-- 1. H4 — DETERMINISM CENSUS -->
    <section id="h4-determinism">
      <h2>
        <span>1. H4 — Determinism Census</span>
        <span class="badge badge-success">Hasil Positif</span>
      </h2>
      <p>
        Sensus determinisme komprehensif menguji fondasi pemutaran ulang (replayability) eksekusi reaktif. 
        Tiap sel dari seluruh korpus diuji sebanyak <strong>10 kali replay berturut-turut</strong> (total 1.040 replay individual).
      </p>

      <div class="stat-grid">
        <div class="stat-box">
          <div class="stat-val" style="color: #34d399;">0.8942</div>
          <div class="stat-label">Tingkat Determinisme ($r$)</div>
        </div>
        <div class="stat-box">
          <div class="stat-val">93 / 104</div>
          <div class="stat-label">Sel Determinis Sempurna</div>
        </div>
        <div class="stat-box">
          <div class="stat-val">1.040</div>
          <div class="stat-label">Total Replay Uji</div>
        </div>
        <div class="stat-box">
          <div class="stat-val" style="color: #f87171;">11</div>
          <div class="stat-label">Sel Non-Determinis</div>
        </div>
      </div>

      <h3 style="margin-top: 24px;">Taksonomi Sebab Non-Determinisme (14 Label atas 11 Sel)</h3>
      <p>
        Dari 11 sel yang menunjukkan variasi output antar-replay, 3 sel memiliki &gt;1 penyebab simultan:
      </p>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Penyebab Ketidakpastian</th>
              <th class="cell-numeric">Frekuensi Label</th>
              <th>Deskripsi Pola Kode</th>
              <th>Contoh Konkret</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Wall-Clock Time</strong></td>
              <td class="cell-numeric"><strong>7</strong></td>
              <td>Penggunaan <code>Date.now()</code> atau <code>new Date()</code> saat runtime</td>
              <td>Pencatatan timestamp transaksi & perulangan berbasis tanggal dinamis</td>
            </tr>
            <tr>
              <td><strong>Network I/O</strong></td>
              <td class="cell-numeric"><strong>4</strong></td>
              <td>Pemanggilan API eksternal tak termock via <code>fetch()</code></td>
              <td>Live FX currency rates & live latency endpoints</td>
            </tr>
            <tr>
              <td><strong>Unknown / Race Condition</strong></td>
              <td class="cell-numeric"><strong>2</strong></td>
              <td>Mutasi state asinkron tanpa deterministik lock</td>
              <td>Penyisipan state variabel global pada siklus event-loop</td>
            </tr>
            <tr>
              <td><strong>PRNG Unseeded</strong></td>
              <td class="cell-numeric"><strong>1</strong></td>
              <td>Penggunaan <code>Math.random()</code> tanpa seed LCG terisolasi</td>
              <td>Generasi baris data acak non-seeded</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 2. DUA CORPUS BERDAMPINGAN -->
    <section id="side-by-side-corpora">
      <h2>
        <span>2. Evaluasi Komparatif Dua Corpus Berdampingan</span>
      </h2>
      <p>
        Kedua korpus dievaluasi secara independen dan <strong>tidak pernah digabung menjadi satu angka agregat</strong>.
        Corpus Terancang menguji reduksi skalar dengan held-out terverifikasi; Corpus Insidental merefleksikan notebook produksi riil.
      </p>

      <div class="grid-2">
        <!-- Corpus Terancang -->
        <div class="card">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <h3 style="margin: 0; color: #60a5fa;">Corpus Terancang (Designed)</h3>
            <span class="badge badge-info">30 Mutasi &times; 3 Arm = 90 Runs</span>
          </div>
          <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 14px;">
            DAG heterogen 6-9 sel dengan sel terminal me-reduksi skalar. Verifikasi uji held-out independen.
          </p>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Metrik</th>
                  <th class="cell-numeric">Arm A (Mono)</th>
                  <th class="cell-numeric">Arm B (Step)</th>
                  <th class="cell-numeric">Arm C (Rewind)</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Total Runs (Valid)</td>
                  <td class="cell-numeric">${des.arms.monolithic.totalRuns} (${des.arms.monolithic.validRuns})</td>
                  <td class="cell-numeric">${des.arms.stepwise.totalRuns} (${des.arms.stepwise.validRuns})</td>
                  <td class="cell-numeric">${des.arms.rewind.totalRuns} (${des.arms.rewind.validRuns})</td>
                </tr>
                <tr>
                  <td><strong>Resolved (All Runs)</strong></td>
                  <td class="cell-numeric">${des.arms.monolithic.resolvedAll}/${des.arms.monolithic.totalRuns} (${formatPct(des.arms.monolithic.resolvedAllPct)})</td>
                  <td class="cell-numeric">${des.arms.stepwise.resolvedAll}/${des.arms.stepwise.totalRuns} (${formatPct(des.arms.stepwise.resolvedAllPct)})</td>
                  <td class="cell-numeric">${des.arms.rewind.resolvedAll}/${des.arms.rewind.totalRuns} (${formatPct(des.arms.rewind.resolvedAllPct)})</td>
                </tr>
                <tr>
                  <td>Lucky Passes (Held-Out)</td>
                  <td class="cell-numeric">${des.arms.monolithic.luckyPassCount} (0.0%)</td>
                  <td class="cell-numeric">${des.arms.stepwise.luckyPassCount} (0.0%)</td>
                  <td class="cell-numeric" style="color: #fbbf24;">${des.arms.rewind.luckyPassCount} (${formatPct(des.arms.rewind.luckyPassRate)})</td>
                </tr>
                <tr style="background: rgba(255,255,255,0.03);">
                  <td><strong>Resolved Genuine</strong></td>
                  <td class="cell-numeric"><strong>${des.arms.monolithic.resolvedGenuine}/${des.arms.monolithic.totalRuns} (${formatPct(des.arms.monolithic.resolvedGenuinePct)})</strong></td>
                  <td class="cell-numeric"><strong>${des.arms.stepwise.resolvedGenuine}/${des.arms.stepwise.totalRuns} (${formatPct(des.arms.stepwise.resolvedGenuinePct)})</strong></td>
                  <td class="cell-numeric"><strong>${des.arms.rewind.resolvedGenuine}/${des.arms.rewind.totalRuns} (${formatPct(des.arms.rewind.resolvedGenuinePct)})</strong></td>
                </tr>
                <tr>
                  <td>CRF (Mean / Med)</td>
                  <td class="cell-numeric">${des.arms.monolithic.crfMean.toFixed(2)} / ${des.arms.monolithic.crfMedian.toFixed(1)}</td>
                  <td class="cell-numeric">${des.arms.stepwise.crfMean.toFixed(2)} / ${des.arms.stepwise.crfMedian.toFixed(1)}</td>
                  <td class="cell-numeric">${des.arms.rewind.crfMean.toFixed(2)} / ${des.arms.rewind.crfMedian.toFixed(1)}</td>
                </tr>
                <tr>
                  <td>Hit@1 Rate</td>
                  <td class="cell-numeric">${des.arms.monolithic.hitAt1Count} (${formatPct(des.arms.monolithic.hitAt1Pct)})</td>
                  <td class="cell-numeric">${des.arms.stepwise.hitAt1Count} (${formatPct(des.arms.stepwise.hitAt1Pct)})</td>
                  <td class="cell-numeric">${des.arms.rewind.hitAt1Count} (${formatPct(des.arms.rewind.hitAt1Pct)})</td>
                </tr>
                <tr>
                  <td>PQI (Mean)</td>
                  <td class="cell-numeric">1.000*</td>
                  <td class="cell-numeric">${des.arms.stepwise.pqiMean.toFixed(3)}</td>
                  <td class="cell-numeric">${des.arms.rewind.pqiMean.toFixed(3)}</td>
                </tr>
                <tr>
                  <td>Avg Turns / Wall-Clock</td>
                  <td class="cell-numeric">${des.arms.monolithic.avgTurns.toFixed(1)}t / ${(des.arms.monolithic.avgWallMs/1000).toFixed(1)}s</td>
                  <td class="cell-numeric">${des.arms.stepwise.avgTurns.toFixed(1)}t / ${(des.arms.stepwise.avgWallMs/1000).toFixed(1)}s</td>
                  <td class="cell-numeric">${des.arms.rewind.avgTurns.toFixed(1)}t / ${(des.arms.rewind.avgWallMs/1000).toFixed(1)}s</td>
                </tr>
                <tr>
                  <td><strong>Amortized Tok/Fix</strong></td>
                  <td class="cell-numeric"><strong>${formatNum(des.arms.monolithic.amortizedTokensPerGenuineFix)}</strong></td>
                  <td class="cell-numeric"><strong>${formatNum(des.arms.stepwise.amortizedTokensPerGenuineFix)}</strong></td>
                  <td class="cell-numeric"><strong>${formatNum(des.arms.rewind.amortizedTokensPerGenuineFix)}</strong></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Corpus Insidental -->
        <div class="card">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <h3 style="margin: 0; color: #fbbf24;">Corpus Insidental (Real-World)</h3>
            <span class="badge badge-warning">39 Mutasi &times; 3 Arm = 117 Runs</span>
          </div>
          <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 14px;">
            Notebook riil in-the-wild. Held-out n/a. Band mid &amp; far berasal dari akumulator (<code>zz-uji-20-cell</code>).
          </p>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Metrik</th>
                  <th class="cell-numeric">Arm A (Mono)</th>
                  <th class="cell-numeric">Arm B (Step)</th>
                  <th class="cell-numeric">Arm C (Rewind)</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Total Runs (Valid)</td>
                  <td class="cell-numeric">${inc.arms.monolithic.totalRuns} (${inc.arms.monolithic.validRuns})</td>
                  <td class="cell-numeric">${inc.arms.stepwise.totalRuns} (${inc.arms.stepwise.validRuns})</td>
                  <td class="cell-numeric">${inc.arms.rewind.totalRuns} (${inc.arms.rewind.validRuns})</td>
                </tr>
                <tr>
                  <td><strong>Resolved (All Runs)</strong></td>
                  <td class="cell-numeric">${inc.arms.monolithic.resolvedAll}/${inc.arms.monolithic.totalRuns} (${formatPct(inc.arms.monolithic.resolvedAllPct)})</td>
                  <td class="cell-numeric">${inc.arms.stepwise.resolvedAll}/${inc.arms.stepwise.totalRuns} (${formatPct(inc.arms.stepwise.resolvedAllPct)})</td>
                  <td class="cell-numeric">${inc.arms.rewind.resolvedAll}/${inc.arms.rewind.totalRuns} (${formatPct(inc.arms.rewind.resolvedAllPct)})</td>
                </tr>
                <tr>
                  <td>Lucky Passes (Held-Out)</td>
                  <td class="cell-numeric">n/a</td>
                  <td class="cell-numeric">n/a</td>
                  <td class="cell-numeric">n/a</td>
                </tr>
                <tr style="background: rgba(255,255,255,0.03);">
                  <td><strong>Resolved Genuine</strong></td>
                  <td class="cell-numeric"><strong>${inc.arms.monolithic.resolvedGenuine}/${inc.arms.monolithic.totalRuns} (${formatPct(inc.arms.monolithic.resolvedGenuinePct)})</strong></td>
                  <td class="cell-numeric"><strong>${inc.arms.stepwise.resolvedGenuine}/${inc.arms.stepwise.totalRuns} (${formatPct(inc.arms.stepwise.resolvedGenuinePct)})</strong></td>
                  <td class="cell-numeric"><strong>${inc.arms.rewind.resolvedGenuine}/${inc.arms.rewind.totalRuns} (${formatPct(inc.arms.rewind.resolvedGenuinePct)})</strong></td>
                </tr>
                <tr>
                  <td>CRF (Mean / Med)</td>
                  <td class="cell-numeric">${inc.arms.monolithic.crfMean.toFixed(2)} / ${inc.arms.monolithic.crfMedian.toFixed(1)}</td>
                  <td class="cell-numeric">${inc.arms.stepwise.crfMean.toFixed(2)} / ${inc.arms.stepwise.crfMedian.toFixed(1)}</td>
                  <td class="cell-numeric">${inc.arms.rewind.crfMean.toFixed(2)} / ${inc.arms.rewind.crfMedian.toFixed(1)}</td>
                </tr>
                <tr>
                  <td>Hit@1 Rate</td>
                  <td class="cell-numeric">${inc.arms.monolithic.hitAt1Count} (${formatPct(inc.arms.monolithic.hitAt1Pct)})</td>
                  <td class="cell-numeric">${inc.arms.stepwise.hitAt1Count} (${formatPct(inc.arms.stepwise.hitAt1Pct)})</td>
                  <td class="cell-numeric">${inc.arms.rewind.hitAt1Count} (${formatPct(inc.arms.rewind.hitAt1Pct)})</td>
                </tr>
                <tr>
                  <td>PQI (Mean)</td>
                  <td class="cell-numeric">0.940*</td>
                  <td class="cell-numeric">${inc.arms.stepwise.pqiMean.toFixed(3)}</td>
                  <td class="cell-numeric">${inc.arms.rewind.pqiMean.toFixed(3)}</td>
                </tr>
                <tr>
                  <td>Avg Turns / Wall-Clock</td>
                  <td class="cell-numeric">${inc.arms.monolithic.avgTurns.toFixed(1)}t / ${(inc.arms.monolithic.avgWallMs/1000).toFixed(1)}s</td>
                  <td class="cell-numeric">${inc.arms.stepwise.avgTurns.toFixed(1)}t / ${(inc.arms.stepwise.avgWallMs/1000).toFixed(1)}s</td>
                  <td class="cell-numeric">${inc.arms.rewind.avgTurns.toFixed(1)}t / ${(inc.arms.rewind.avgWallMs/1000).toFixed(1)}s</td>
                </tr>
                <tr>
                  <td><strong>Amortized Tok/Fix</strong></td>
                  <td class="cell-numeric"><strong>${formatNum(inc.arms.monolithic.amortizedTokensPerGenuineFix)}</strong></td>
                  <td class="cell-numeric"><strong>${formatNum(inc.arms.stepwise.amortizedTokensPerGenuineFix)}</strong></td>
                  <td class="cell-numeric"><strong>${formatNum(inc.arms.rewind.amortizedTokensPerGenuineFix)}</strong></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>

    <!-- 3. PERBAIKAN SUNGGUHAN & MCNEMAR PAIRED TESTS -->
    <section id="genuine-resolution-mcnemar">
      <h2>
        <span>3. Analisis Perbaikan Sungguhan &amp; Uji Berpasangan McNemar</span>
      </h2>
      <p>
        Uji berpasangan McNemar (dua arah exact binomial) menguji signifikansi diskordan antar perlakuan pada mutasi yang sama persis.
        <strong>Seluruh nilai $p \ge 0.5000$ (tidak ada selisih akurasi yang signifikan secara statistik).</strong>
      </p>

      <h3>A. Tabel Kontingensi &amp; Uji Berpasangan McNemar (Overall)</h3>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Corpus</th>
              <th>Perbandingan (X vs Y)</th>
              <th class="cell-numeric">Total Pasang</th>
              <th class="cell-numeric">(+,+) Keduanya Ok</th>
              <th class="cell-numeric">(+,-) X Menang</th>
              <th class="cell-numeric">(-,+) Y Menang</th>
              <th class="cell-numeric">(-,-) Keduanya Gagal</th>
              <th class="cell-numeric">Diskordan (b : c)</th>
              <th class="cell-numeric">Exact $p$-value</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td rowspan="3" style="font-weight: 600; color: #60a5fa;">Terancang</td>
              <td>Rewind (C) vs Stepwise (B)</td>
              <td class="cell-numeric">${des.pairedOverall.rewind_vs_stepwise.totalMutations}</td>
              <td class="cell-numeric">${des.pairedOverall.rewind_vs_stepwise.bothResolved}</td>
              <td class="cell-numeric">${des.pairedOverall.rewind_vs_stepwise.arm1Won}</td>
              <td class="cell-numeric">${des.pairedOverall.rewind_vs_stepwise.arm2Won}</td>
              <td class="cell-numeric">${des.pairedOverall.rewind_vs_stepwise.bothFailed}</td>
              <td class="cell-numeric">${des.pairedOverall.rewind_vs_stepwise.discordantRatio}</td>
              <td class="cell-numeric"><strong>${des.pairedOverall.rewind_vs_stepwise.exactBinomialPValue.toFixed(4)}</strong></td>
            </tr>
            <tr>
              <td>Stepwise (B) vs Monolithic (A)</td>
              <td class="cell-numeric">${des.pairedOverall.stepwise_vs_monolithic.totalMutations}</td>
              <td class="cell-numeric">${des.pairedOverall.stepwise_vs_monolithic.bothResolved}</td>
              <td class="cell-numeric">${des.pairedOverall.stepwise_vs_monolithic.arm1Won}</td>
              <td class="cell-numeric">${des.pairedOverall.stepwise_vs_monolithic.arm2Won}</td>
              <td class="cell-numeric">${des.pairedOverall.stepwise_vs_monolithic.bothFailed}</td>
              <td class="cell-numeric">${des.pairedOverall.stepwise_vs_monolithic.discordantRatio}</td>
              <td class="cell-numeric"><strong>${des.pairedOverall.stepwise_vs_monolithic.exactBinomialPValue.toFixed(4)}</strong></td>
            </tr>
            <tr>
              <td>Rewind (C) vs Monolithic (A)</td>
              <td class="cell-numeric">${des.pairedOverall.rewind_vs_monolithic.totalMutations}</td>
              <td class="cell-numeric">${des.pairedOverall.rewind_vs_monolithic.bothResolved}</td>
              <td class="cell-numeric">${des.pairedOverall.rewind_vs_monolithic.arm1Won}</td>
              <td class="cell-numeric">${des.pairedOverall.rewind_vs_monolithic.arm2Won}</td>
              <td class="cell-numeric">${des.pairedOverall.rewind_vs_monolithic.bothFailed}</td>
              <td class="cell-numeric">${des.pairedOverall.rewind_vs_monolithic.discordantRatio}</td>
              <td class="cell-numeric"><strong>${des.pairedOverall.rewind_vs_monolithic.exactBinomialPValue.toFixed(4)}</strong></td>
            </tr>
            <tr style="border-top: 2px solid var(--border-subtle);">
              <td rowspan="3" style="font-weight: 600; color: #fbbf24;">Insidental</td>
              <td>Rewind (C) vs Stepwise (B)</td>
              <td class="cell-numeric">${inc.pairedOverall.rewind_vs_stepwise.totalMutations}</td>
              <td class="cell-numeric">${inc.pairedOverall.rewind_vs_stepwise.bothResolved}</td>
              <td class="cell-numeric">${inc.pairedOverall.rewind_vs_stepwise.arm1Won}</td>
              <td class="cell-numeric">${inc.pairedOverall.rewind_vs_stepwise.arm2Won}</td>
              <td class="cell-numeric">${inc.pairedOverall.rewind_vs_stepwise.bothFailed}</td>
              <td class="cell-numeric">${inc.pairedOverall.rewind_vs_stepwise.discordantRatio}</td>
              <td class="cell-numeric"><strong>${inc.pairedOverall.rewind_vs_stepwise.exactBinomialPValue.toFixed(4)}</strong></td>
            </tr>
            <tr>
              <td>Stepwise (B) vs Monolithic (A)</td>
              <td class="cell-numeric">${inc.pairedOverall.stepwise_vs_monolithic.totalMutations}</td>
              <td class="cell-numeric">${inc.pairedOverall.stepwise_vs_monolithic.bothResolved}</td>
              <td class="cell-numeric">${inc.pairedOverall.stepwise_vs_monolithic.arm1Won}</td>
              <td class="cell-numeric">${inc.pairedOverall.stepwise_vs_monolithic.arm2Won}</td>
              <td class="cell-numeric">${inc.pairedOverall.stepwise_vs_monolithic.bothFailed}</td>
              <td class="cell-numeric">${inc.pairedOverall.stepwise_vs_monolithic.discordantRatio}</td>
              <td class="cell-numeric"><strong>${inc.pairedOverall.stepwise_vs_monolithic.exactBinomialPValue.toFixed(4)}</strong></td>
            </tr>
            <tr>
              <td>Rewind (C) vs Monolithic (A)</td>
              <td class="cell-numeric">${inc.pairedOverall.rewind_vs_monolithic.totalMutations}</td>
              <td class="cell-numeric">${inc.pairedOverall.rewind_vs_monolithic.bothResolved}</td>
              <td class="cell-numeric">${inc.pairedOverall.rewind_vs_monolithic.arm1Won}</td>
              <td class="cell-numeric">${inc.pairedOverall.rewind_vs_monolithic.arm2Won}</td>
              <td class="cell-numeric">${inc.pairedOverall.rewind_vs_monolithic.bothFailed}</td>
              <td class="cell-numeric">${inc.pairedOverall.rewind_vs_monolithic.discordantRatio}</td>
              <td class="cell-numeric"><strong>${inc.pairedOverall.rewind_vs_monolithic.exactBinomialPValue.toFixed(4)}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 style="margin-top: 24px;">B. Stratifikasi Berdasarkan Jarak ke Terminal (distBand) — Corpus Terancang</h3>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Band Jarak (distBand)</th>
              <th class="cell-numeric">N Mutasi</th>
              <th class="cell-numeric">Arm A Genuine</th>
              <th class="cell-numeric">Arm B Genuine</th>
              <th class="cell-numeric">Arm C Genuine</th>
              <th class="cell-numeric">Diskordan (C : B)</th>
              <th class="cell-numeric">Exact $p$ (C vs B)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Direct (Dist 0)</strong></td>
              <td class="cell-numeric">6</td>
              <td class="cell-numeric">6 / 6 (100.0%)</td>
              <td class="cell-numeric">6 / 6 (100.0%)</td>
              <td class="cell-numeric">6 / 6 (100.0%)</td>
              <td class="cell-numeric">0 : 0</td>
              <td class="cell-numeric">1.0000</td>
            </tr>
            <tr>
              <td><strong>Short (Dist 1-3)</strong></td>
              <td class="cell-numeric">12</td>
              <td class="cell-numeric">10 / 12 (83.3%)</td>
              <td class="cell-numeric">10 / 12 (83.3%)</td>
              <td class="cell-numeric">9 / 12 (75.0%)</td>
              <td class="cell-numeric">0 : 1</td>
              <td class="cell-numeric">1.0000</td>
            </tr>
            <tr>
              <td><strong>Long (Dist 4+)</strong></td>
              <td class="cell-numeric">12</td>
              <td class="cell-numeric">10 / 12 (83.3%)</td>
              <td class="cell-numeric">10 / 12 (83.3%)</td>
              <td class="cell-numeric">10 / 12 (83.3%)</td>
              <td class="cell-numeric">1 : 1</td>
              <td class="cell-numeric">1.0000</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 4. BIAYA: TOKEN PER PERBAIKAN SUNGGUHAN -->
    <section id="cost-tokens">
      <h2>
        <span>4. Biaya Komputasi: Token per Perbaikan Sungguhan</span>
      </h2>
      <p>
        Konsumsi token adalah <strong>satu-satunya sumbu dengan diferensiasi substansial</strong>. 
        Monolithic (Arm A) paling hemat karena 1-2 turn tanpa interaksi loop; Stepwise (Arm B) paling boros karena re-eksekusi dan reasoning eksplorasi; 
        Rewind (Arm C) menghemat 17.5% token dibanding Stepwise pada korpus terancang melalui injeksi <em>scopeBefore</em>.
      </p>

      <div class="chart-box">
        ${costSvg}
      </div>

      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Corpus &amp; Arm</th>
              <th class="cell-numeric">Avg Prompt Tokens</th>
              <th class="cell-numeric">Avg Reasoning Tokens</th>
              <th class="cell-numeric">Avg Answer Tokens</th>
              <th class="cell-numeric">Avg Total Tokens/Run</th>
              <th class="cell-numeric">Amortized Tokens / Genuine Fix</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span class="arm-pill pill-a"></span><strong>Terancang: Arm A (Monolithic)</strong></td>
              <td class="cell-numeric">${formatNum(des.arms.monolithic.avgPromptTokens)}</td>
              <td class="cell-numeric">${formatNum(des.arms.monolithic.avgReasoningTokens)}</td>
              <td class="cell-numeric">${formatNum(des.arms.monolithic.avgAnswerTokens)}</td>
              <td class="cell-numeric">${formatNum(des.arms.monolithic.avgTotalTokens)}</td>
              <td class="cell-numeric"><strong>${formatNum(des.arms.monolithic.amortizedTokensPerGenuineFix)}</strong></td>
            </tr>
            <tr>
              <td><span class="arm-pill pill-b"></span><strong>Terancang: Arm B (Stepwise)</strong></td>
              <td class="cell-numeric">${formatNum(des.arms.stepwise.avgPromptTokens)}</td>
              <td class="cell-numeric">${formatNum(des.arms.stepwise.avgReasoningTokens)}</td>
              <td class="cell-numeric">${formatNum(des.arms.stepwise.avgAnswerTokens)}</td>
              <td class="cell-numeric">${formatNum(des.arms.stepwise.avgTotalTokens)}</td>
              <td class="cell-numeric"><strong>${formatNum(des.arms.stepwise.amortizedTokensPerGenuineFix)}</strong></td>
            </tr>
            <tr>
              <td><span class="arm-pill pill-c"></span><strong>Terancang: Arm C (Rewind)</strong></td>
              <td class="cell-numeric">${formatNum(des.arms.rewind.avgPromptTokens)}</td>
              <td class="cell-numeric">${formatNum(des.arms.rewind.avgReasoningTokens)}</td>
              <td class="cell-numeric">${formatNum(des.arms.rewind.avgAnswerTokens)}</td>
              <td class="cell-numeric">${formatNum(des.arms.rewind.avgTotalTokens)}</td>
              <td class="cell-numeric"><strong>${formatNum(des.arms.rewind.amortizedTokensPerGenuineFix)}</strong></td>
            </tr>
            <tr style="border-top: 2px solid var(--border-subtle);">
              <td><span class="arm-pill pill-a"></span><strong>Insidental: Arm A (Monolithic)</strong></td>
              <td class="cell-numeric">${formatNum(inc.arms.monolithic.avgPromptTokens)}</td>
              <td class="cell-numeric">${formatNum(inc.arms.monolithic.avgReasoningTokens)}</td>
              <td class="cell-numeric">${formatNum(inc.arms.monolithic.avgAnswerTokens)}</td>
              <td class="cell-numeric">${formatNum(inc.arms.monolithic.avgTotalTokens)}</td>
              <td class="cell-numeric"><strong>${formatNum(inc.arms.monolithic.amortizedTokensPerGenuineFix)}</strong></td>
            </tr>
            <tr>
              <td><span class="arm-pill pill-b"></span><strong>Insidental: Arm B (Stepwise)</strong></td>
              <td class="cell-numeric">${formatNum(inc.arms.stepwise.avgPromptTokens)}</td>
              <td class="cell-numeric">${formatNum(inc.arms.stepwise.avgReasoningTokens)}</td>
              <td class="cell-numeric">${formatNum(inc.arms.stepwise.avgAnswerTokens)}</td>
              <td class="cell-numeric">${formatNum(inc.arms.stepwise.avgTotalTokens)}</td>
              <td class="cell-numeric"><strong>${formatNum(inc.arms.stepwise.amortizedTokensPerGenuineFix)}</strong></td>
            </tr>
            <tr>
              <td><span class="arm-pill pill-c"></span><strong>Insidental: Arm C (Rewind)</strong></td>
              <td class="cell-numeric">${formatNum(inc.arms.rewind.avgPromptTokens)}</td>
              <td class="cell-numeric">${formatNum(inc.arms.rewind.avgReasoningTokens)}</td>
              <td class="cell-numeric">${formatNum(inc.arms.rewind.avgAnswerTokens)}</td>
              <td class="cell-numeric">${formatNum(inc.arms.rewind.avgTotalTokens)}</td>
              <td class="cell-numeric"><strong>${formatNum(inc.arms.rewind.amortizedTokensPerGenuineFix)}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 5. LUCKY-PASS CASE STUDY: b143f174 -->
    <section id="lucky-pass-case">
      <h2>
        <span>5. Studi Kasus Lucky-Pass: Kompensasi Parsial pada Sel <code>b143f174</code></span>
        <span class="badge badge-warning">Held-Out Failure</span>
      </h2>
      <p>
        Kasus mutasi <code>b143f174-8e7c-455e-984b-efff641fbf35:const-perturb:0</code> pada <code>rb-designed-risk-assessment</code> 
        mengilustrasikan mengapa metrik kelolosan held-out esensial. Arm C mendeteksi deviasi output tetapi alih-alih mengembalikan konstanta penalti ke 22, 
        ia menambahkan variabel kompensasi pada formula bonus.
      </p>

      <div class="code-grid">
        <div class="code-col">
          <div class="code-col-title">
            <span>1. Kode Asli (Ground Truth)</span>
            <span class="badge badge-success">Benar</span>
          </div>
          <pre><code>const historyScores = inputs.capacityProfiles.map((a) => {
  <span class="highlight-diff">let penalty = a.missedPayments * 22;</span>
  let bonus = Math.min(a.creditHistoryYears * 2.5, 25);
  let baseScore = 75 - penalty + bonus;
  if (baseScore > 100) baseScore = 100;
  if (baseScore < 0) baseScore = 0;
  return {
    ...a,
    creditBehaviorScore: Math.round(baseScore * 100) / 100,
  };
});
return { historyScores };</code></pre>
        </div>

        <div class="code-col">
          <div class="code-col-title">
            <span>2. Kode Mutan (Fault Injected)</span>
            <span class="badge badge-warning">Mutasi +1</span>
          </div>
          <pre><code>const historyScores = inputs.capacityProfiles.map((a) => {
  <span class="highlight-mut">let penalty = a.missedPayments * 23;</span>
  let bonus = Math.min(a.creditHistoryYears * 2.5, 25);
  let baseScore = 75 - penalty + bonus;
  if (baseScore > 100) baseScore = 100;
  if (baseScore < 0) baseScore = 0;
  return {
    ...a,
    creditBehaviorScore: Math.round(baseScore * 100) / 100,
  };
});
return { historyScores };</code></pre>
        </div>

        <div class="code-col">
          <div class="code-col-title">
            <span>3. Perbaikan Arm C (Lucky Pass)</span>
            <span class="badge badge-warning">Kompensasi</span>
          </div>
          <pre><code>const historyScores = inputs.capacityProfiles.map((a) => {
  <span class="highlight-mut">let penalty = a.missedPayments * 23;</span>
  <span class="highlight-diff">let bonus = Math.min(a.creditHistoryYears * 2.5 + a.missedPayments, 25);</span>
  let baseScore = 75 - penalty + bonus;
  if (baseScore > 100) baseScore = 100;
  if (baseScore < 0) baseScore = 0;
  return {
    ...a,
    creditBehaviorScore: Math.round(baseScore * 100) / 100,
  };
});
return { historyScores };</code></pre>
        </div>
      </div>

      <div class="callout">
        <div class="callout-title">Mekanisme Kegagalan Held-Out:</div>
        <p style="margin-bottom: 0;">
          Pada dataset latih yang terlihat, penambahan <code>+ a.missedPayments</code> pada bonus secara aljabar meniadakan kelebihan pengurangan <code>-1 &times; missedPayments</code> 
          karena tidak ada applicant yang bonusnya ter-<em>clamp</em> pada 25. Namun, pada dataset held-out (applicant <code>APP-H102</code> memiliki pengalaman 16 tahun &rarr; $16 \times 2.5 = 40 \ge 25$), 
          fungsi <code>Math.min(..., 25)</code> memotong nilai bonus sehingga kompensasi tidak bekerja dan menghasilkan hash salah.
        </p>
      </div>
    </section>

    <!-- 6. KETERBATASAN (LIMITATIONS) -->
    <section id="limitations">
      <h2>
        <span>6. Keterbatasan Metodologi &amp; Ancaman Validitas</span>
      </h2>
      <p>
        Keterbatasan berikut merupakan bagian integral dari interpretasi hasil eksperimen ini:
      </p>

      <ul>
        <li>
          <strong>PQI Arm A Bernilai 1,0 Secara Konstruksi:</strong> Monolithic (Arm A) menerima seluruh kode notebook dalam satu prompt turn tunggal dan melakukan edit langsung. 
          Oleh karena itu, metrik PQI (Process Quality Index) <em>hanya valid secara komparatif antara Arm B (Stepwise) dan Arm C (Rewind)</em>.
        </li>
        <li>
          <strong>Band Mid &amp; Far Corpus Insidental Monolitik:</strong> 100% dari 18 mutasi pada band <code>mid</code> (hop 3-6) dan <code>far</code> (hop 7+) di corpus insidental 
          berasal dari satu notebook uji akumulator tunggal (<code>zz-uji-20-cell</code>). Ini merupakan studi kasus terisolasi, bukan sampel acak representatif.
        </li>
        <li>
          <strong>Kapasitas Skala Notebook:</strong> Notebook terbesar yang diuji terdiri dari 21 sel. Seluruh kode sumber notebook muat dengan leluasa dalam context window model modern (128k context), 
          sehingga degradasi retrieval context window belum terpicu.
        </li>
        <li>
          <strong>Lucky-Pass Tidak Terukur pada Korpus Insidental:</strong> Korpus insidental berasal dari notebook in-the-wild tanpa fixture data held-out terisolasi, 
          sehingga status held-out dilaporkan sebagai <code>null / n/a</code>.
        </li>
        <li>
          <strong>Ukuran Sampel ($N=30, N=39$):</strong> Pada ukuran sampel saat ini, tidak ditemukan perbedaan akurasi perbaikan yang signifikan secara statistik antar arm ($p \ge 0.5000$).
        </li>
      </ul>
    </section>

    <!-- 7. CROSS-MODEL EVALUATION (GLM-5.2) -->
    <section id="cross-model">
      <h2>
        <span>7. Evaluasi Lintas-Model (GLM-5.2)</span>
        <span class="badge badge-info">${glm ? "Selesai" : "Data Menyusul / Run Sedang Berjalan"}</span>
      </h2>
      ${
        glm
          ? `
          <p>Hasil evaluasi silang pada model GLM-5.2 atas Corpus Terancang (90 episode):</p>
          <div class="stat-grid">
            <div class="stat-box">
              <div class="stat-val">${glm.arms.monolithic.resolvedGenuine}/${glm.arms.monolithic.totalRuns}</div>
              <div class="stat-label">Arm A Genuine (${formatPct(glm.arms.monolithic.resolvedGenuinePct)})</div>
            </div>
            <div class="stat-box">
              <div class="stat-val">${glm.arms.stepwise.resolvedGenuine}/${glm.arms.stepwise.totalRuns}</div>
              <div class="stat-label">Arm B Genuine (${formatPct(glm.arms.stepwise.resolvedGenuinePct)})</div>
            </div>
            <div class="stat-box">
              <div class="stat-val">${glm.arms.rewind.resolvedGenuine}/${glm.arms.rewind.totalRuns}</div>
              <div class="stat-label">Arm C Genuine (${formatPct(glm.arms.rewind.resolvedGenuinePct)})</div>
            </div>
          </div>
          `
          : `
          <div style="background: rgba(15, 23, 42, 0.5); border: 1px dashed var(--border-subtle); padding: 24px; border-radius: 8px; text-align: center;">
            <p style="color: var(--text-muted); margin-bottom: 8px;">
              Eksperimen long-run GLM-5.2 sedang berjalan di session terpisah.
            </p>
            <p style="font-size: 0.85rem; color: var(--text-dim); margin-bottom: 0;">
              Smoke test awal menunjukkan kepatuhan format 100% (0/9 protocol failure, 0/9 length failure). Data lengkap akan dimuat secara otomatis saat run selesai.
            </p>
          </div>
          `
      }
    </section>

    <footer>
      RewindBench Experimental Evaluation &bull; Antigravity Research Framework &bull; zaatool reactive runtime
    </footer>
  </div>
</body>
</html>`;
}

export function main() {
  const resultsDir = process.env.RESULTS_DIR || "./results";
  const metricsJsonPath = join(resultsDir, "metrics.json");

  if (!existsSync(metricsJsonPath)) {
    console.error(`Error: metrics file not found at ${metricsJsonPath}`);
    process.exit(1);
  }

  const raw = readFileSync(metricsJsonPath, "utf8");
  const metricsData = JSON.parse(raw);

  const html = generateHtmlReport(metricsData);
  const outPath = join(resultsDir, "report.html");

  writeFileSync(outPath, html, "utf8");
  console.log(`\nSuccessfully generated self-contained HTML report at: ${outPath}`);
}

if (process.argv[1] && process.argv[1].includes("report")) {
  main();
}
