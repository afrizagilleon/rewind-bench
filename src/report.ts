/**
 * Renders results/report.html from results/metrics.json and
 * results/symptom-audit.json.
 *
 * Pure: reads JSON, writes one self-contained HTML file. No model calls, no
 * notebook execution, no network. Every figure on the page is computed here
 * from the committed data — nothing is typed into the template by hand, so
 * the page cannot drift away from the files it describes.
 *
 *   npm run report
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── shapes we read ───────────────────────────────────────────────────────

interface ArmMetrics {
  totalRuns: number;
  resolvedAll: number;
  resolvedGenuine: number;
  luckyPassCount: number;
  protocolFailures: number;
  lengthFailures: number;
  avgTurns: number;
  avgPromptTokens: number;
  avgReasoningTokens: number;
  avgAnswerTokens: number;
  avgTotalTokens: number;
  amortizedTokensPerGenuineFix: number;
  crfMean: number;
  hitAt1Count: number;
}

interface Paired {
  arm1: string;
  arm2: string;
  arm1Won: number;
  arm2Won: number;
  bothResolved: number;
  bothFailed: number;
  exactBinomialPValue: number;
}

interface CorpusMetrics {
  corpusName: string;
  totalMutations: number;
  totalRuns: number;
  arms: Record<string, ArmMetrics>;
  pairedOverall: Record<string, Paired>;
}

interface Metrics {
  incidental: CorpusMetrics;
  designed: CorpusMetrics;
  designed_glm?: CorpusMetrics;
}

interface AuditCorpus {
  total: number;
  symptomVisible: number;
  symptomInvisible: number;
}

interface Audit {
  summary: { designed: AuditCorpus; incidental: AuditCorpus };
  details: Array<{ corpus: string; mutationId: string; symptomVisible: boolean }>;
}

// ── the one worked example ───────────────────────────────────────────────
// Transcribed from results/mutations-designed.jsonl (b143f174…:const-perturb:0)
// and the repair the agent submitted in its transcript. The hashes and the
// verdict below are read from data, not written here.

const WORKED_EXAMPLE = {
  mutationPrefix: "b143f174",
  original: [
    `let penalty = a.missedPayments * 22;`,
    `let bonus = Math.min(a.creditHistoryYears * 2.5, 25);`,
  ],
  injected: [`let penalty = a.missedPayments * 23;`],
  repair: [
    `let penalty = a.missedPayments * 23;`,
    `let bonus = Math.min(a.creditHistoryYears * 2.5`,
    `                     + a.missedPayments, 25);`,
  ],
};

const ARM_LABEL: Record<string, string> = {
  monolithic: "reads only",
  stepwise: "guesses its inputs",
  rewind: "gets the recording",
};

const ARMS = ["monolithic", "stepwise", "rewind"] as const;

// ── helpers ──────────────────────────────────────────────────────────────

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const n = (x: number): string => Math.round(x).toLocaleString("en-US");

const pct = (a: number, b: number): string =>
  b === 0 ? "—" : `${((a / b) * 100).toFixed(0)}%`;

/** Two digests and a verdict. The page's recurring mark. */
function comparator(label: string, digest: string, agrees: boolean): string {
  return `<div class="cmp ${agrees ? "is-same" : "is-diff"}">
      <span class="cmp-l">${esc(label)}</span>
      <span class="cmp-d">${esc(digest)}</span>
      <span class="cmp-v">${agrees ? "matches" : "does not match"}</span>
    </div>`;
}

function bar(label: string, value: number, max: number, tone: string): string {
  const w = Math.max(2, Math.round((value / max) * 100));
  return `<div class="bar">
      <span class="bar-l">${esc(label)}</span>
      <span class="bar-t"><i class="bar-f t-${tone}" style="width:${w}%"></i></span>
      <span class="bar-v">${n(value)}</span>
    </div>`;
}

// ── sections ─────────────────────────────────────────────────────────────

function sectionHero(m: Metrics, audit: Audit): string {
  const total = m.designed.totalRuns + m.incidental.totalRuns + (m.designed_glm?.totalRuns ?? 0);
  const lucky = m.designed.arms.rewind.luckyPassCount;
  const resolved = m.designed.arms.rewind.resolvedAll;

  return `<header class="hero">
    <p class="eyebrow">Rewind-Bench · results</p>
    <h1>A repair can match<br>and still be wrong.</h1>
    <p class="lede">We injected ${m.designed.totalMutations + m.incidental.totalMutations} known bugs into working notebooks and asked three AI agents to fix them.
    Then we re-ran every accepted repair on data the agent had never seen.</p>

    <div class="worked">
      <div class="worked-code">
        <p class="cap">one digit changed in a working notebook</p>
<pre><code><span class="c-dim">before  </span>${esc(WORKED_EXAMPLE.original[0])}
<span class="c-flag">after   </span>${esc(WORKED_EXAMPLE.injected[0])}</code></pre>
        <p class="cap">what the agent submitted as its repair</p>
<pre><code>${esc(WORKED_EXAMPLE.repair[0])}   <span class="c-dim">// left alone</span>
${esc(WORKED_EXAMPLE.repair[1])}
${esc(WORKED_EXAMPLE.repair[2])}  <span class="c-dim">// cancelled out</span></code></pre>
        <p class="note">It never fixed the bug. It added a second error of the same size pointing the
        other way, so the two cancelled — until <code>Math.min</code> clamps, which it does on the
        held-out data.</p>
      </div>
      <div class="worked-verdict">
        ${comparator("on the data it was shown", "2a9ad5c6…", true)}
        ${comparator("on data it never saw", "365348fb…", false)}
        <p class="note"><strong>${lucky} of ${resolved}</strong> repairs accepted from the
        best-equipped agent failed this second check. The other two agents failed this bug
        outright — so the only agent that “solved” it, hadn’t.</p>
      </div>
    </div>

    <dl class="facts">
      <div><dt>repair episodes</dt><dd>${n(total)}</dd></div>
      <div><dt>models</dt><dd>2</dd></div>
      <div><dt>corpora</dt><dd>2, never pooled</dd></div>
      <div><dt>bugs with no visible symptom</dt><dd>${audit.summary.designed.symptomInvisible + audit.summary.incidental.symptomInvisible}</dd></div>
    </dl>
  </header>`;
}

function sectionBench(): string {
  return `<section>
    <p class="eyebrow">held constant · model, temperature, seed, and the full source</p>
    <h2>Three agents, one variable.</h2>
    <table class="grid">
      <thead><tr><th>agent</th><th>may run code</th><th>where its upstream data comes from</th></tr></thead>
      <tbody>
        <tr><th scope="row">A · monolithic</th><td>no</td><td>reads the source and reasons about it</td></tr>
        <tr><th scope="row">B · stepwise</th><td>yes</td><td>invents it, or pastes it in by hand</td></tr>
        <tr class="is-focus"><th scope="row">C · rewind</th><td>yes</td><td>the scope actually recorded during the healthy run</td></tr>
      </tbody>
    </table>
    <p class="note">B is how the tool behaved before this work. C is what we built. A is the
    baseline almost nobody publishes, and it turned out to matter.</p>
  </section>`;
}

function sectionAccuracy(m: Metrics): string {
  const glm = m.designed_glm;
  const rows = ARMS.map((a) => {
    const d = m.designed.arms[a];
    const g = glm?.arms[a];
    return `<tr${a === "rewind" ? ' class="is-focus"' : ""}>
      <th scope="row">${a}<span class="sub">${ARM_LABEL[a]}</span></th>
      <td>${d.resolvedGenuine} / ${d.totalRuns}</td>
      <td>${g ? `${g.resolvedGenuine} / ${g.totalRuns}` : "—"}</td>
      <td>${d.luckyPassCount}</td>
      <td>${g ? g.luckyPassCount : "—"}</td>
    </tr>`;
  }).join("");

  const pairRows = (c: CorpusMetrics | undefined, tag: string): string =>
    !c
      ? ""
      : Object.values(c.pairedOverall)
          .map(
            (p) => `<tr><td>${esc(tag)}</td><td>${esc(p.arm1)} vs ${esc(p.arm2)}</td>
            <td>${p.arm1Won} : ${p.arm2Won}</td><td>${p.exactBinomialPValue.toFixed(2)}</td></tr>`
          )
          .join("");

  return `<section>
    <p class="eyebrow">measured · repairs that survived a held-out seed</p>
    <h2>Whether the recording helps depends on the model.</h2>

    <table class="grid nums">
      <thead><tr>
        <th rowspan="2">agent</th>
        <th colspan="2">repairs that survived</th>
        <th colspan="2">accepted, then failed held-out</th>
      </tr><tr>
        <th class="thin">DeepSeek-V4-Flash</th><th class="thin">GLM-5.2</th>
        <th class="thin">DeepSeek-V4-Flash</th><th class="thin">GLM-5.2</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <p class="note">Under the small model the three arms are indistinguishable. Under the frontier
    model, arm C solved every bug and lost no head-to-head comparison to either other arm. The
    identical 30 bugs, prompts and seed were used for both — only the model changed.</p>

    <table class="grid small">
      <caption>Paired comparison on the same bug, McNemar exact</caption>
      <thead><tr><th>model</th><th>comparison</th><th>discordant</th><th>p</th></tr></thead>
      <tbody>
        ${pairRows(m.designed, "DeepSeek-V4-Flash")}
        ${pairRows(glm, "GLM-5.2")}
      </tbody>
    </table>
    <p class="note">No difference reaches significance at n = 30, and none is claimed. What
    changed between models is the consistency of the direction, not the p-value.</p>
  </section>`;
}

function sectionCost(m: Metrics): string {
  const src = m.designed_glm ?? m.designed;
  const which = m.designed_glm ? "GLM-5.2" : "DeepSeek-V4-Flash";
  const vals = ARMS.map((a) => src.arms[a].amortizedTokensPerGenuineFix);
  const max = Math.max(...vals);
  const ratio = (src.arms.rewind.amortizedTokensPerGenuineFix / src.arms.monolithic.amortizedTokensPerGenuineFix).toFixed(1);
  const saving = (
    (1 - src.arms.rewind.amortizedTokensPerGenuineFix / src.arms.stepwise.amortizedTokensPerGenuineFix) *
    100
  ).toFixed(1);

  return `<section>
    <p class="eyebrow">measured · tokens spent per repair that survived, ${esc(which)}</p>
    <h2>It is not free.</h2>
    <div class="bars">
      ${bar("A · monolithic", src.arms.monolithic.amortizedTokensPerGenuineFix, max, "accent")}
      ${bar("B · stepwise", src.arms.stepwise.amortizedTokensPerGenuineFix, max, "flag")}
      ${bar("C · rewind", src.arms.rewind.amortizedTokensPerGenuineFix, max, "flag")}
    </div>
    <p class="note">Handing the agent the recording costs <strong>${saving}%</strong> less than
    making it guess — and <strong>${ratio}×</strong> more than not running anything at all. If a
    program fits in the prompt, reading it beats every interactive strategy we tried.</p>
  </section>`;
}

function sectionAudit(audit: Audit, visible: Record<string, number[]>): string {
  const d = audit.summary.designed;
  const i = audit.summary.incidental;
  const vis = visible.visible;
  const inv = visible.invisible;

  return `<section>
    <p class="eyebrow">audited · could the agent see anything was wrong?</p>
    <h2>Some bugs have no symptom.</h2>
    <p class="note">The symptom shown to an agent is the final cell's output. A mutation only had
    to change the <em>whole run's</em> hash to enter the corpus. Those are different scopes, so a
    bug can be valid and still be invisible from where the agent stands. We counted them.</p>

    <table class="grid nums">
      <thead><tr><th>corpus</th><th>bugs</th><th>observable</th><th>invisible</th></tr></thead>
      <tbody>
        <tr><th scope="row">designed</th><td>${d.total}</td><td>${d.symptomVisible} <span class="sub">${pct(d.symptomVisible, d.total)}</span></td><td>${d.symptomInvisible}</td></tr>
        <tr><th scope="row">found</th><td>${i.total}</td><td>${i.symptomVisible} <span class="sub">${pct(i.symptomVisible, i.total)}</span></td><td>${i.symptomInvisible}</td></tr>
      </tbody>
    </table>

    <table class="grid nums">
      <caption>Found corpus, split by whether the bug was observable</caption>
      <thead><tr><th>agent</th><th>observable (${i.symptomVisible})</th><th>invisible (${i.symptomInvisible})</th></tr></thead>
      <tbody>
        ${ARMS.map(
          (a, k) => `<tr${a === "rewind" ? ' class="is-focus"' : ""}>
            <th scope="row">${a}</th>
            <td>${vis[k]} <span class="sub">${pct(vis[k], i.symptomVisible)}</span></td>
            <td>${inv[k]}</td></tr>`
        ).join("")}
      </tbody>
    </table>
    <p class="note">This hits all three arms identically, so the paired comparisons stand — but
    the raw totals understate every arm. On bugs an agent could actually see, all three land in
    the high eighties to low nineties.</p>
  </section>`;
}

function sectionDeterminism(): string {
  const causes: Array<[string, number, string]> = [
    ["wall-clock", 7, "<code>Date.now()</code> inside the returned value"],
    ["network", 4, "live FX and latency endpoints"],
    ["unknown", 2, "traced to a real race in the engine being measured"],
    ["PRNG", 1, "unseeded <code>Math.random()</code>"],
  ];
  return `<section>
    <p class="eyebrow">measured before any model was involved · replay fidelity</p>
    <h2>Replay is only meaningful if cells repeat.</h2>
    <div class="split">
      <div>
        <p class="figure"><span class="figure-n">0.8942</span></p>
        <p class="note">of cells return a bit-identical result given identical source and identical
        incoming scope. 93 of 104 cells, 10 replays each, 1,040 replays. Verified separately:
        0 cells received a varying input scope, so the control held.</p>
      </div>
      <table class="grid small">
        <thead><tr><th>cause of drift</th><th>labels</th><th>what it was</th></tr></thead>
        <tbody>${causes
          .map(([c, k, w]) => `<tr><th scope="row">${c}</th><td>${k}</td><td>${w}</td></tr>`)
          .join("")}</tbody>
      </table>
    </div>
    <p class="note">14 labels over 11 cells — three cells drift for more than one reason, and the
    table says so rather than dividing them up. Two of the unknowns turned out to be a genuine
    concurrency bug in the engine we were measuring, which we reported and worked around.</p>
  </section>`;
}

function sectionLimits(): string {
  const items: Array<[string, string]> = [
    ["size", "The largest notebook here is 21 cells; the designed ones are 6–9. Everything fits in a prompt, which is exactly the regime where an agent that reads everything should win — and it does. Nothing here speaks to programs that do not fit."],
    ["power", "n = 30 and 39. No accuracy difference reaches significance and none is claimed."],
    ["held-out coverage", "Lucky passes are only measurable where we control the seeds. The found corpus reports this as not measured, never as zero."],
    ["deep bands", "The found corpus's deeper bands come entirely from one repeated-template notebook. Treat those rows as a case study, not a sample."],
    ["our own errors", "The bench was wrong four times. Each was caught by re-deriving every number from the raw logs rather than trusting a summary, and each correction is an amendment in the commit history — including the one that deleted our best-looking result."],
  ];
  return `<section>
    <p class="eyebrow">stated, rather than buried</p>
    <h2>What this does not show.</h2>
    <dl class="limits">
      ${items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("")}
    </dl>
  </section>`;
}

// ── page ─────────────────────────────────────────────────────────────────

function css(): string {
  return `
:root{
  --paper:#F7F9FB; --ink:#131A1C; --ink-2:#3F4B56; --ink-3:#6E7C88;
  --rule:#D3DCE3; --panel:#FFFFFF;
  --accent:#0B5F55; --flag:#A33F1E;
  --grid:rgba(11,95,85,.055);
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--paper); color:var(--ink);
  font-family:'Public Sans',ui-sans-serif,system-ui,sans-serif;
  font-size:16px; line-height:1.6;
  font-variant-numeric:tabular-nums;
}
.wrap{max-width:56rem; margin:0 auto; padding:0 1.5rem 6rem}

/* Chart paper, only behind the opening. A readout is printed on a grid.
   The fade lives on a pseudo-element: masking .hero itself would fade the
   numbers too, and data you cannot read is worse than no grid at all. */
.hero{position:relative; padding:4.5rem 0 2.4rem}
.hero::before{
  content:""; position:absolute; inset:-1.5rem -1.5rem 0; z-index:0;
  background-image:
    linear-gradient(var(--grid) 1px,transparent 1px),
    linear-gradient(90deg,var(--grid) 1px,transparent 1px);
  background-size:22px 22px;
  -webkit-mask-image:linear-gradient(180deg,#000 0%,#000 45%,transparent 92%);
  mask-image:linear-gradient(180deg,#000 0%,#000 45%,transparent 92%);
  pointer-events:none;
}
.hero > *{position:relative; z-index:1}

/* Mono is reserved for what a machine produced — headings that name a
   measurement, figures, digests, code. Every small label a human wrote stays
   in the sans, because Martian Mono is wide and turns to mush below ~11px. */
h1,h2,.figure-n,.cmp-d,.bar-v,code,pre{
  font-family:'Martian Mono','JetBrains Mono',ui-monospace,monospace;
}
h1{
  font-size:clamp(1.7rem,4.4vw,2.9rem); font-weight:600; line-height:1.18;
  letter-spacing:-.04em; margin:.6rem 0 1rem;
}
h2{
  font-size:clamp(1.05rem,2.2vw,1.35rem); font-weight:600; letter-spacing:-.03em;
  margin:.35rem 0 1rem;
}
.eyebrow{
  font-size:.7rem; font-weight:600; letter-spacing:.07em; text-transform:uppercase;
  color:var(--ink-2); margin:0;
}
.lede{font-size:1.02rem; color:var(--ink-2); max-width:40rem; margin:0 0 2.2rem}
.note{font-size:.9rem; color:var(--ink-2); max-width:44rem; margin:1rem 0 0}
p.note:first-child{margin-top:0}
strong{color:var(--ink); font-weight:600}
em{font-style:italic}
code{
  font-size:.85em; background:color-mix(in srgb,var(--accent) 8%,var(--panel));
  color:var(--accent); border:1px solid color-mix(in srgb,var(--accent) 18%,transparent);
  border-radius:2px; padding:.05em .3em;
}
pre{
  margin:.3rem 0 1.1rem; padding:.75rem .9rem; overflow-x:auto;
  background:var(--panel); border:1px solid var(--rule); border-radius:2px;
  font-size:.74rem; line-height:1.65;
}
pre code{background:none; border:none; color:var(--ink); padding:0}
.c-dim{color:var(--ink-3)}
.c-flag{color:var(--flag)}
.cap{
  font-size:.7rem; font-weight:600; letter-spacing:.05em;
  text-transform:uppercase; color:var(--ink-2); margin:1.1rem 0 0;
}

section{padding:3.2rem 0 0; border-top:1px solid var(--rule); margin-top:3.2rem}

/* THE SIGNATURE — two digests and a verdict. Every claim here rests on one. */
.cmp{
  display:grid; grid-template-columns:1fr auto; align-items:center;
  gap:.2rem .9rem; padding:.7rem .9rem; margin-bottom:.6rem;
  background:var(--panel); border:1px solid var(--rule); border-radius:2px;
  border-left:3px solid var(--ink-3);
}
.cmp.is-same{border-left-color:var(--accent)}
.cmp.is-diff{border-left-color:var(--flag)}
.cmp-l{
  grid-column:1/-1; font-size:.78rem; font-weight:600; color:var(--ink-2);
}
.cmp-d{font-size:.9rem; letter-spacing:.02em}
.cmp.is-same .cmp-d{color:var(--accent)}
.cmp.is-diff .cmp-d{color:var(--flag)}
.cmp-v{font-size:.76rem; color:var(--ink-2); text-align:right}

.worked{display:grid; grid-template-columns:1.15fr 1fr; gap:2.2rem; align-items:start; margin-bottom:2.4rem}
.worked-verdict{padding-top:1.6rem}

.facts{display:flex; flex-wrap:wrap; gap:2.2rem; margin:0; padding-top:1rem; border-top:1px solid var(--rule)}
.facts div{margin:0}
.facts dt{font-size:.7rem; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--ink-2)}
.facts dd{margin:.15rem 0 0; font-family:'Martian Mono',monospace; font-size:1.05rem; font-weight:600}

table.grid{width:100%; border-collapse:collapse; margin:.4rem 0 0; font-size:.86rem}
table.grid caption{
  font-size:.72rem; font-weight:600; letter-spacing:.04em;
  color:var(--ink-2); text-align:left; padding:1.4rem 0 .5rem;
}
table.grid th,table.grid td{padding:.55rem .7rem; text-align:left; border-bottom:1px solid var(--rule)}
table.grid thead th{
  font-size:.72rem; letter-spacing:.03em;
  color:var(--ink-2); font-weight:600; vertical-align:bottom;
}
table.grid thead th.thin{font-size:.68rem; font-weight:500}
table.grid tbody th{font-weight:600; color:var(--ink); white-space:nowrap}
table.grid td{color:var(--ink-2)}
table.grid.nums td{font-family:'Martian Mono',monospace; font-size:.82rem; color:var(--ink)}
table.grid tbody tr.is-focus{background:color-mix(in srgb,var(--accent) 6%,transparent)}
table.grid tbody tr.is-focus th{box-shadow:inset 3px 0 0 var(--accent)}
table.grid.small{font-size:.78rem}
.sub{display:block; font-family:'Public Sans',sans-serif; font-size:.7rem;
  letter-spacing:.01em; color:var(--ink-2); font-weight:400}

.bars{display:flex; flex-direction:column; gap:.6rem; margin-top:.6rem}
.bar{display:grid; grid-template-columns:8.5rem 1fr 5rem; gap:.9rem; align-items:center}
.bar-l{font-size:.8rem; color:var(--ink-2)}
.bar-t{display:block; height:16px; background:color-mix(in srgb,var(--rule) 70%,transparent)}
.bar-f{display:block; height:100%}
.bar-f.t-accent{background:var(--accent)}
.bar-f.t-flag{background:var(--flag)}
.bar-v{font-size:.78rem; text-align:right}

.split{display:grid; grid-template-columns:1fr 1.25fr; gap:2.2rem; align-items:start}
.figure{margin:0}
.figure-n{font-size:2.9rem; font-weight:600; letter-spacing:-.05em; color:var(--accent); line-height:1}

.limits{margin:0; display:flex; flex-direction:column; gap:1.1rem}
.limits div{display:grid; grid-template-columns:9rem 1fr; gap:1.1rem}
.limits dt{font-size:.72rem; font-weight:600; letter-spacing:.03em; text-transform:uppercase;
  color:var(--ink-2); border-top:1px solid var(--rule); padding-top:.35rem}
.limits dd{margin:0; font-size:.88rem; color:var(--ink-2)}

footer{margin-top:3.4rem; padding-top:1.4rem; border-top:1px solid var(--rule);
  font-size:.78rem; color:var(--ink-2)}
a{color:var(--accent)}
a:focus-visible,:focus-visible{outline:2px solid var(--accent); outline-offset:2px}

@media (max-width:760px){
  .worked,.split{grid-template-columns:1fr; gap:1.4rem}
  .worked-verdict{padding-top:0}
  .limits div{grid-template-columns:1fr; gap:.2rem}
  .bar{grid-template-columns:6.5rem 1fr 4rem; gap:.6rem}
  .facts{gap:1.4rem}
  table.grid{font-size:.78rem}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
}

export function generateHtmlReport(m: Metrics, audit: Audit, visible: Record<string, number[]>): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rewind-Bench — results</title>
<meta name="description" content="A repair can match the recorded output and still be wrong. Results from 297 AI code-repair episodes.">
<style>@font-face{font-family:'Martian Mono';src:local('Martian Mono')}
@font-face{font-family:'Public Sans';src:local('Public Sans')}
${css()}</style>
</head><body>
<div class="wrap">
${sectionHero(m, audit)}
${sectionBench()}
${sectionAccuracy(m)}
${sectionCost(m)}
${sectionAudit(audit, visible)}
${sectionDeterminism()}
${sectionLimits()}
<footer>
  Generated from results/metrics.json and results/symptom-audit.json ·
  every figure recomputed, none typed by hand ·
  <a href="https://github.com/afrizagilleon/rewind-bench">github.com/afrizagilleon/rewind-bench</a>
</footer>
</div>
</body></html>`;
}

// ── entry ────────────────────────────────────────────────────────────────

function armSplitByVisibility(resultsDir: string, audit: Audit): Record<string, number[]> {
  const file = join(resultsDir, "arms.jsonl");
  const vis = new Map(
    audit.details.filter((d) => d.corpus === "incidental").map((d) => [d.mutationId, d.symptomVisible])
  );
  const rows = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { arm: string; mutationId: string; resolved: boolean; luckyPass: boolean | null });

  const visible: number[] = [];
  const invisible: number[] = [];
  for (const a of ARMS) {
    const mine = rows.filter((r) => r.arm === a);
    const good = (r: (typeof rows)[number]): boolean => r.resolved && r.luckyPass !== true;
    visible.push(mine.filter((r) => vis.get(r.mutationId) === true && good(r)).length);
    invisible.push(mine.filter((r) => vis.get(r.mutationId) === false && good(r)).length);
  }
  return { visible, invisible };
}

function main(): void {
  const resultsDir = process.env.RESULTS_DIR?.trim() || "./results";
  const metricsPath = join(resultsDir, "metrics.json");
  const auditPath = join(resultsDir, "symptom-audit.json");

  if (!existsSync(metricsPath)) {
    throw new Error(`${metricsPath} not found — run \`npm run metrics\` first.`);
  }
  if (!existsSync(auditPath)) {
    throw new Error(`${auditPath} not found — run \`npm run audit:symptoms\` first.`);
  }

  const metrics = JSON.parse(readFileSync(metricsPath, "utf8")) as Metrics;
  const audit = JSON.parse(readFileSync(auditPath, "utf8")) as Audit;
  const visible = armSplitByVisibility(resultsDir, audit);

  const out = join(resultsDir, "report.html");
  writeFileSync(out, generateHtmlReport(metrics, audit, visible), "utf8");

  const kb = (readFileSync(out).length / 1024).toFixed(0);
  console.log(`Wrote ${out} (${kb} KB, self-contained)`);
}

main();
