# Rewind-Bench — technical overview

*ImpactForge Summer 2026 · Computational Research*
Repo: https://github.com/afrizagilleon/rewind-bench

---

## The problem

Every AI agent that repairs code reports a pass rate. That number is almost always measured against the same data the agent was looking at while it worked.

That is a weak test. An agent can make the visible output match without fixing anything — by adding a second error that cancels the first. It passes, ships, and breaks the first time the inputs change.

Nobody publishes how often this happens, because measuring it needs two things at once: a known correct answer, and a second dataset the agent never saw.

## What we built

A bench that runs the same injected bug past three agents that differ in exactly one variable — **what evidence about the failing run they are allowed to see** — and then re-checks every repair against a held-out seed.

| | may execute code? | where its upstream data comes from |
|---|---|---|
| A · monolithic | no | reads the source and reasons |
| B · stepwise | yes | invents it, or pastes it in by hand |
| C · rewind | yes | the real recorded scope, injected |

297 episodes: 30 designed bugs × 3 arms × 2 models, plus 39 bugs found in real notebooks × 3 arms.

## Stack

- **Substrate:** [zaatool](https://github.com/afrizagilleon/zaatool), a reactive-notebook automation tool built months before this hackathon for unrelated reasons and **not modified by this project**. Rewind-Bench drives it only through its public REST and MCP surfaces.
- **Harness:** TypeScript on Node 24, `tsx`, `vitest` (113 unit tests, no credentials needed), `acorn` for AST mutation.
- **Inference:** Featherless.ai, OpenAI-compatible. `deepseek-ai/DeepSeek-V4-Flash-0731` and `zai-org/GLM-5.2`.
- **Results:** append-only JSONL plus a full transcript per episode. Metrics and the HTML report recompute from those files and call no model.

### Why zaatool made this cheap

Values crossing a cell boundary in zaatool are **JSON by design** — the notebook's state is serialisable, so it can be rehydrated per request instead of requiring a live kernel. Recording the exact scope a cell saw therefore costs one write.

The closest prior art, [Kishu (arXiv:2504.01377)](https://arxiv.org/abs/2504.01377), checkpoints notebooks over a live Python kernel and must diff an object graph, which is lossy and expensive. Same idea, different substrate, very different price. The literature review came first; the substrate was picked because it fit.

### Inference pipeline

Deterministic across arms (temperature 0, fixed seed). Token accounting split **prompt / reasoning / answer**, because reasoning turned out to be 65–100% of completion tokens and one `total_tokens` figure would have hidden the entire cost story. Failures split into **protocol** (malformed reply), **length** (truncated) and **repair** (genuinely wrong) — collapsing those into "failed" discards data. Session tokens refresh automatically on a mid-run 401; transport errors are retried once and counted, never folded into results. A worker pool runs mutations in parallel with per-shard output files.

One deliberate trade: the agent protocol is fenced JSON rather than native tool calling, which is why `protocolFailure` exists as a category. The gain is portability — the same pipeline ran on two providers' models with one environment variable changed and no code touched.

## What was hard

**The instrument was wrong four times, and each time it looked fine.**

Every milestone was specified as a contract, implemented by a separate coding agent, then verified by re-deriving every reported number from the raw JSONL. That verification — not the implementation — is where the work was:

1. A corpus where 76% of bugs **named themselves in the symptom** (`expected a1, got a1_v2`). Nothing to diagnose; all arms scored 100%.
2. An instrument with **no resolving power**: two-thirds of mutations sat in cells that read nothing, so the "recorded evidence" handed to arm C was literally `{}`.
3. A difficulty axis **pointing the wrong way**. We banded by distance from producer to consumer; in a linear chain that puts the "hardest" band on the last cell — exactly where the symptom already points. Correcting it invalidated our best-looking result.
4. A lucky-pass metric so tautological it **never fired once in 45 runs**.

Three separate times, an agent's written summary disagreed with the file it described. `results/metrics.json` is the record; prose is not.

The other hard part was staying honest when the first full run went against the hypothesis. It is recorded as-is, and it turned out to be half the finding.

## What we found

**1. Seven percent of the best-equipped agent's repairs were fake.** They matched the recorded output and stopped working on a seed the agent had never seen. One example, verbatim: the injected bug changed a penalty multiplier from 22 to 23; the agent left it and added `+ a.missedPayments` to a bonus term, cancelling the error exactly — until `Math.min` clamps on other data.

**2. Recorded evidence only converts if the model can use it.** Identical 30 bugs, identical prompts and seed, only the model changed:

| repairs that survived | DeepSeek-V4-Flash | GLM-5.2 |
|---|---|---|
| A · monolithic | 26 / 30 | 28 / 30 |
| B · stepwise | 27 / 30 | 27 / 30 |
| C · rewind | 26 / 30 | **30 / 30** |

Under the small model arm C lost as many paired comparisons as it won. Under the frontier model it lost none, to either arm.

**3. It is still not free.** Arm C cost **3.7×** the tokens of arm A — which never executed a line — to gain two repairs in thirty. If a file fits in the prompt, reading it beats every interactive strategy we tried.

**4. Cells are 89.42% bit-reproducible** given identical source and identical incoming scope (93/104 cells, 1,040 replays), with all 11 exceptions classified. Two of them were a genuine race condition in zaatool itself, diagnosed and reported upstream; it resurfaced under `--concurrency=3` and the client mitigation handled it.

## What this does not show

- Largest notebook is 21 cells; everything fits in a prompt, which is exactly the regime where the reader arm should win — and does. Nothing here applies to files that don't fit.
- n = 30 and 39. No accuracy difference reaches significance (McNemar exact, p = 0.25 and 0.50) and none is claimed. What changed across models is the consistency of direction, not the p-value.
- Held-out checking needs seeds we control, so it runs on one corpus only. The other reports `n/a`, not zero.
- The symptom shown to the agent is the terminal cell's output, while validity and success compare the whole run's hash. A mutation can therefore pass validation while producing no observable symptom. This hits all three arms identically, so paired comparisons stand, but absolute solve rates are understated.
