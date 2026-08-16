# Rewind-Bench

**Every AI code-repair agent reports a pass rate. That pass rate is measured against the data the agent already saw.**

Rewind-Bench re-checks each repair against data it never saw — and on our corpus, **7% of the repairs from the best-equipped agent were fake**. They matched the recorded output and stopped working the moment the input changed.

Built for ImpactForge Summer 2026, Computational Research track. 297 recorded repair episodes across two corpora and two models, every transcript in this repo.

---

## The finding, in one table

Same 30 injected bugs. Same prompts, same seed, same temperature. Three agents that differ in **one thing only**: what evidence about the failing run they are allowed to see.

| | reads code only | executes, guesses its own inputs | executes, gets the *recorded* inputs |
|---|---|---|---|
| | **A · monolithic** | **B · stepwise** | **C · rewind** |
| repairs that held up (DeepSeek-V4-Flash) | 26 / 30 | 27 / 30 | 26 / 30 |
| repairs that held up (GLM-5.2) | 28 / 30 | 27 / 30 | **30 / 30** |
| tokens per surviving repair (GLM-5.2) | **15,923** | 87,397 | 58,855 |

Two things fall out, and they only make sense together:

1. **Recorded evidence is wasted on a small model.** Under DeepSeek-V4-Flash the three arms are indistinguishable — arm C lost as many paired comparisons as it won.
2. **Under a frontier model it converts.** Under GLM-5.2 arm C solved every bug and lost no paired comparison to any arm — but still cost **3.7× more tokens** than simply reading the whole notebook and thinking about it.

Neither difference reaches significance at n = 30 (McNemar exact, p = 0.25 and 0.50). What changed between models is not the p-value but the *consistency of the direction*: zero reversals under GLM-5.2, random sign under DeepSeek.

## Why "repairs that held up" and not "repairs that passed"

Because those are different numbers, and the gap is the point.

Each designed notebook ships with a **second seed the agent never sees**. After a repair passes the visible check, the notebook is re-run on that seed and the output hash is compared again. A repair that only matched the data it was shown is recorded as a **lucky pass**, not a success.

This caught our own favoured arm. Injected bug: a penalty multiplier changed from 22 to 23.

```js
// original
let penalty = a.missedPayments * 22;
let bonus = Math.min(a.creditHistoryYears * 2.5, 25);

// what arm C submitted as the repair
let penalty = a.missedPayments * 23;                              // left alone
let bonus = Math.min(a.creditHistoryYears * 2.5
                     + a.missedPayments, 25);                     // cancelled out
```

The penalty rises by one per missed payment; the bonus was raised by exactly the same amount. Output matched. It passed — right up to the moment `Math.min` clamps at 25, which it does on the held-out seed. The other two arms failed this bug outright, so the only arm that "solved" it, didn't.

Transcript: [`results/transcripts-deepseek/rewind-b143f174-8e7c-455e-984b-efff641fbf35_const-perturb_0.json`](results/transcripts-deepseek/)

---

## Why this could be measured here at all

Rewind-Bench runs on [**zaatool**](https://github.com/afrizagilleon/zaatool), a reactive-notebook automation tool built before this hackathon for an unrelated practical need. It is not modified by this project — Rewind-Bench only drives it over its public REST and MCP surfaces.

One architectural fact makes the whole experiment cheap:

> Values crossing a cell boundary in zaatool are **JSON by design**. The notebook's state is serialisable, so it can be rehydrated per request instead of requiring a live kernel.

That means the exact scope a cell saw during a healthy run can be recorded and replayed **exactly, for the cost of one write**. Prior art — [Kishu, arXiv:2504.01377](https://arxiv.org/abs/2504.01377) — checkpoints real notebooks too, but must diff the object graph of a live Python kernel, which is lossy and expensive. Different substrate, different price.

The literature review came first; the substrate was chosen because it fit, not the other way round.

### A prerequisite we had to measure before anything else

Replaying recorded state is only meaningful if cells are reproducible in the first place. So, before any LLM was involved:

**r = 0.8942** — given an identical `(source, incoming scope)` pair, 93 of 104 cells return a bit-identical result across 10 replays each (1,040 replays). Every one of the 11 exceptions is classified:

| cause | labels | what it was |
|---|---|---|
| wall-clock | 7 | `Date.now()` inside the returned value |
| network | 4 | live FX and latency endpoints |
| unknown | 2 | traced to a real race in the engine being measured |
| PRNG | 1 | unseeded `Math.random()` |

14 labels over 11 cells — three cells drift for more than one reason, and the table says so rather than dividing them up. Verified independently: 0 cells received a varying input scope, so the control variable held.

The two "unknown" cases turned out to be a genuine concurrency bug in zaatool: a run could be reported `success` before its last cell result was readable. Diagnosed, reported upstream, and mitigated client-side here. It resurfaced twice under `--concurrency=3` during the cross-model run and the mitigation handled it.

---

## Setup

**Requirements:** Node 24+, a running zaatool instance, and any OpenAI-compatible inference endpoint.

```bash
git clone https://github.com/afrizagilleon/rewind-bench
cd rewind-bench
npm install
cp .env.example .env    # then fill it in — see below
npm run typecheck && npm test
```

`npm run test:unit` runs **113 tests** and needs no credentials and no running engine — start there to confirm the install. `npm test` adds the integration suite, which does need a live zaatool.

### Filling in `.env`

zaatool uses **two different credentials**, and they are not interchangeable. `/api/*` verifies a session JWT; the MCP endpoint takes an agent token and rejects the JWT. See [`API-REFERENCE.md`](API-REFERENCE.md).

```ini
ZAA_BASE_URL=http://localhost:4000     # the engine, not the Vite dev server on :5173
ZAA_SESSION_TOKEN=                     # browser → DevTools → localStorage.getItem('zaatool_token')
ZAA_USERNAME=                          # optional: lets a long run refresh its own token
ZAA_PASSWORD=
ZAA_AGENT_TOKEN=                       # MCP, scope "author"

FEATHERLESS_API_KEY=
FEATHERLESS_BASE_URL=https://api.featherless.ai/v1
MODEL_PRIMARY=deepseek-ai/DeepSeek-V4-Flash-0731
```

Any OpenAI-compatible endpoint works — swapping `MODEL_PRIMARY` and `FEATHERLESS_BASE_URL` is the entire change needed to run a different provider. That is how the cross-model comparison was produced: one environment variable, zero code changes.

### Reproducing the results without spending a token

Every result in this repo is derived from committed JSONL. The metrics and the report recompute from those files and call no model:

```bash
npm run metrics     # → results/metrics.json, all tables printed
npm run report      # → results/report.html, one self-contained file
```

### Running it for real

```bash
npm run mutate -- --designed          # build the ground-truth corpus
npm run arms -- --designed            # 30 mutations × 3 arms = 90 episodes
npm run arms -- --designed --concurrency=3   # same, in parallel
npm run arms -- --cleanup             # remove any scratch notebooks left behind
```

Mutations are **never written into your own notebooks**. Every run duplicates the target into a scratch notebook named `zz-rewind-arm-*`, works there, and deletes it in a `finally` block. Verified after the fact: 67 source notebooks unchanged, 0 scratch notebooks left.

### The demo

```bash
npm run demo -- --step=1    # restore a known-good notebook, run it, print the score
npm run demo -- --step=2    # inject one bug, run it, print the wrong score
npm run demo -- --step=3    # let the agent repair it, one action per line
npm run demo -- --step=4    # swap in the held-out seed — does the repair survive?
```

Step 3 pauses before each edit so the change is visible in zaatool's own UI if you have the notebook open.

---

## How it works

```
zaatool run history
        │
        ├─ ledger.ts        canonical JSON → sha256. Every value in this project is
        │                   addressed by content, so any claim can be re-derived.
        │
        ├─ msr.ts           Materialized Scope Replay: folds recorded cell outputs
        │                   back into the exact scope a given cell saw. Lane-aware —
        │                   a cell inside a parallel branch sees a *child* of the
        │                   fork-point scope, never its siblings' writes.
        │
        ├─ determinism.ts   replays each cell 10× against the same materialized
        │                   scope and classifies every disagreement
        │
        ├─ mutate.ts        AST operators inject one fault per cell. Two gates:
        │                   the mutant must parse, and it must change the output.
        │
        └─ arms/            three agents over one shared loop. Only the evidence
                            available to each differs.
```

**Inference pipeline.** Deterministic across arms (temperature 0, fixed seed); token accounting split three ways (prompt / reasoning / answer) because reasoning turned out to be 65–100% of completion tokens and a single `total_tokens` figure would have hidden the entire cost story; failures separated into *protocol* (malformed reply), *length* (truncated), and *repair* (genuinely wrong), because collapsing those into "failed" throws away data; session tokens refreshed automatically on a mid-run 401; transport errors retried once and counted, never silently folded into results.

One deliberate limitation: the agent protocol is fenced JSON rather than native tool calling. That is why `protocolFailure` exists as a category. The trade was portability — the same pipeline ran on two providers' models without a line changed.

---

## What this does not show

Stated here rather than buried, because each of these is a real bound on the claims above.

- **Notebook size.** The largest notebook in either corpus is 21 cells; the designed ones are 6–9. Everything fits in a prompt — which is exactly the regime where an agent that reads everything should win, and it does. Nothing here speaks to notebooks that don't fit.
- **Statistical power.** n = 30 and n = 39. No accuracy difference reaches significance, and none is claimed.
- **Held-out coverage.** Lucky passes are only measurable on the designed corpus, whose seeds we control. The found corpus reports `n/a` for that metric — not zero.
- **Some bugs have no symptom.** The symptom shown to the agent is the terminal cell's output, but a mutation only had to change the *whole run's* hash to enter the corpus. Those are not the same scope, so a bug can be valid and still be invisible from where the agent is standing. Audited in `results/symptom-audit.json`: **5 of 30 designed and 11 of 39 found mutations produce no observable symptom.** This hits all three arms identically, so the paired comparisons stand — but the raw totals understate every arm. Restricted to bugs that were actually observable, the found corpus reads:

  | | A · monolithic | B · stepwise | C · rewind |
  |---|---|---|---|
  | observable bugs (28) | 25 (89%) | 26 (93%) | 25 (89%) |
  | unobservable bugs (11) | 2 | 2 | 4 |

  The 69–74% headline is the two rows added together, and it mostly measures how often an agent guesses right with nothing to go on.
- **The found corpus is not a sample in its deep bands.** Its `mid` and `far` hop bands come entirely from one notebook, which is a repeated template — treat those rows as a case study.

## Corpora

| | notebooks | mutations | held-out | note |
|---|---|---|---|---|
| **found** | 67 real notebooks from a working dev instance | 39 | not measurable | nobody designed these to favour anything |
| **designed** | 6 written for this test | 30 | measured | reducing terminal cell, heterogeneous cells, UUID cell ids |

They are reported side by side and **never pooled into one number**. The designed corpus exists because the found one had no notebook deep enough to test the hypothesis — a fact that is itself a finding about real notebooks.

## How this was built

Contract-driven, and the contracts are the interesting part. Each milestone was specified in advance, implemented by a separate coding agent, then verified by re-deriving every reported number from the raw JSONL rather than trusting the summary.

That verification step caught four defects that would have invalidated results, each corrected by an amendment recorded in the commit history:

- a corpus where 76% of mutations named their own bug in the symptom
- an instrument with no resolving power: two-thirds of mutations sat in cells that read nothing, so the injected evidence was literally `{}`
- a difficulty axis pointing the wrong way — the "hardest" band turned out to be the cell the symptom already pointed at
- a lucky-pass metric so tautological it never fired once in 45 runs

It also caught three summaries that disagreed with the files they described. `results/metrics.json` is the record; prose is not.

---

## Licence

MIT. zaatool is a separate MIT-licensed project and is not vendored here.
