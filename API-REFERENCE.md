# zaatool API — verified reference

**Read this before writing `src/client.ts`.** Every shape here was recorded from a live
engine, not inferred. Matching fixtures are in `fixtures/`, so the client's tests run
without a server.

Recorded: 2026-08-14T23:10Z · engine `:4000` · 67 notebooks available.

---

## 1. Auth — two tokens, and they are not interchangeable

This is the single most common way to lose an hour here.

| Surface | Token | Env var | Wrong token gives |
|---|---|---|---|
| `/api/*` (REST) | Session **JWT** | `ZAA_SESSION_TOKEN` | `401` |
| `/mcp` | Agent token `zaa_…` | `ZAA_AGENT_TOKEN` | `401` |

Both use `Authorization: Bearer <token>`. Verified: JWT on `/api/notebooks` → `200`;
agent token on the same path → `401`.

**Why both.** REST returns run details *unabridged*, which the hashing depends on — the
MCP layer runs results through `abridge()`, which truncates large values and would corrupt
a hash silently. So: **REST for reading evidence, MCP for the agentic arms**, because MCP
is the surface a real agent actually uses.

**The JWT expires.** Current one dies `2026-08-15T22:47:31Z` (Sun 16 Aug 05:47 WIB) —
*before* the submission deadline. The client must treat `401` as fatal with a loud message
(`"ZAA_SESSION_TOKEN expired — refresh from localStorage.getItem('zaatool_token')"`),
never as an empty result. A silent 401 during the long benchmark run would produce a
results file full of nulls that looks like data.

---

## 2. Endpoints

### `GET /api/notebooks`
Array of summaries. Fixture: `notebooks-list.json`

```json
[ { "id": "8aee2070-…", "name": "archive-exchange-rates", "runtime": "node" } ]
```

### `GET /api/notebooks/:id`
The notebook document itself. Fixture: `notebook-doc-simple.json`, `notebook-doc-parallel.json`

```json
{
  "version": "1.0",
  "id": "52cc6e6b-…",
  "name": "zz-uji-paralel-3",
  "runtime": "node",
  "steps": [ … ],
  "tags": [],
  "outputs": [ … ]
}
```

`steps[]` entries are one of:

```jsonc
// a cell
{ "id": "a547f958-…", "kind": "cell", "note": "markdown…", "code": "return { started: Date.now() };" }

// a parallel group — lanes, each with its own steps (which may nest further)
{ "id": "…", "kind": "parallel", "lanes": [ { "id": "…", "label": "A — level 1", "steps": [ … ] } ] }
```

A cell with empty/whitespace `code` carries intent only and **never executes** — it will
not appear in `cell_results`. Skip those when building the order.

### `POST /api/notebooks/:id/run`
Starts a run and returns immediately. **Does not wait.**

```jsonc
// request body — all fields optional
{ "input": { "any": "value" }, "args": { … }, "cellId": "…", "mode": "deployed" }
```
```json
{ "status": "started", "runId": "c86363f4-…" }
```

- `cellId` present → runs **only** that cell, starting from an empty scope plus `input`.
  This is the primitive Rewind is built on.
- `input` is seeded into scope verbatim; cells read it as `inputs.<name>`.
- Omit `mode` — the draft is what we want. `"deployed"` runs the deployed copy instead.

### `GET /api/notebooks/:id/runs/:runId`
Full, unabridged run detail. `runId` may be the literal `latest`.
Fixtures: `run-detail-parallel.json`, `run-detail-simple.json`, `run-detail-single-cell.json`

```jsonc
{
  "id": "…", "notebook_id": "…",
  "status": "running" | "success" | "failed",
  "trigger_source": "manual" | "cell" | "cron" | "webhook" | "call" | "tool" | "page",
  "cell_id": null,          // set only when one cell was run
  "parent_run_id": null,
  "error": null,
  "started_at": "2026-08-08T18:44:27.963Z",
  "finished_at": "2026-08-08T18:44:28.670Z",
  "cell_results": {
    "046fe5be-…": {
      "source":  "return { b1a: { lane: 'B.1', level: 2 } };",
      "output":  { "b1a": { "lane": "B.1", "level": 2 } },
      "written": ["b1a"],
      "ms": 41
    }
  }
}
```

A failed cell carries `error` and **no** `output`. `logs` appears only when the cell
logged something.

- Poll this until `status !== "running"`. 250 ms interval, 60 s ceiling.
- `404` → `{ "error": "Run not found" }`

### `GET /api/notebooks/:id/runs`
Run summaries, newest first, **without** `cell_results`. Fixture: `runs-list.json`

---

## 3. The ordering trap — read twice

> **`cell_results` is a map keyed by cell id. It carries no order.**

Execution order lives only in the notebook document's `steps`. Scope reconstruction must
derive it and get it right; if the order is wrong, every scope is wrong, and the results
look plausible while being meaningless.

Flattening rule, matching what the runner actually does:

1. Walk `steps` in array order.
2. `kind: "cell"` with non-empty `code` → append.
3. `kind: "parallel"` → walk `lanes` in array order; within each lane walk its `steps`
   recursively. Lanes may nest (`zz-uji-paralel-3` nests three deep).

**Caveat to state plainly in the writeup:** lanes execute *concurrently*, so a linear order
is a reading convention, not a claim about time. It is sound for scope reconstruction
because zaatool forbids two lanes writing the same name — the engine raises
`lanes "A" and "B" both wrote "x"` rather than letting a race decide. That guarantee is
what makes a flattened order safe here, and it is worth one sentence in the paper.

---

## 4. Known non-deterministic cell — free H4 test case

`zz-uji-paralel-3`, first cell:

```js
return { started: Date.now() };
```

A real wall-clock non-determinism already in the corpus. Use it to prove the determinism
classifier works against something that was not written for the experiment.

---

## 5. Working curl

```bash
JWT=$(grep '^ZAA_SESSION_TOKEN=' .env | cut -d= -f2-)

curl -s -H "Authorization: Bearer $JWT" http://localhost:4000/api/notebooks

curl -s -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"cellId":"<cell-id>","input":{"n":5}}' \
  http://localhost:4000/api/notebooks/<nb-id>/run

curl -s -H "Authorization: Bearer $JWT" \
  http://localhost:4000/api/notebooks/<nb-id>/runs/latest
```
