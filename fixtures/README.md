# Fixtures — recorded, not invented

Real responses from a live zaatool engine, captured 2026-08-14T23:10Z. They exist so the
client's tests run without a server, and so nobody has to guess a response shape.

| File | Endpoint | Why it is here |
|---|---|---|
| `notebooks-list.json` | `GET /api/notebooks` | Summary shape (first 12 of 67) |
| `notebook-doc-simple.json` | `GET /api/notebooks/:id` | Linear notebook, 2 code cells |
| `notebook-doc-parallel.json` | `GET /api/notebooks/:id` | **Three levels of nested lanes** — the hard case for ordering |
| `run-detail-simple.json` | `GET …/runs/:runId` | 2 cells, succeeded |
| `run-detail-parallel.json` | `GET …/runs/:runId` | **8 cells across nested lanes** — the fixture scope reconstruction must satisfy |
| `run-detail-single-cell.json` | `GET …/runs/:runId` | One cell run with injected `input` — the Rewind primitive |
| `runs-list.json` | `GET …/runs` | Summaries, no `cell_results` |

## What to notice

**`cell_results` is keyed by cell id and carries no order.** Execution order comes from the
notebook document's `steps`. `run-detail-parallel.json` is the fixture that will catch an
ordering bug — its lanes nest three deep, which is exactly where a naive flatten breaks.

**`zz-uji-paralel-3`'s first cell is `return { started: Date.now() };`** — genuine
wall-clock non-determinism that was already in the corpus before this experiment existed.
The determinism classifier should catch it without being told.

## Re-recording

These are snapshots. If the engine's shapes change, re-record rather than hand-editing —
a fixture edited by hand stops being evidence.
