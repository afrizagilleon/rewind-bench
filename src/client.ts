/**
 * zaatool REST API Client (R2 / R2.1 / R2.2)
 *
 * Handles HTTP communication with the zaatool engine.
 * Uses ZAA_SESSION_TOKEN (JWT) for all REST API endpoints, with optional
 * auto-refresh via ZAA_USERNAME and ZAA_PASSWORD when expired (R2.2).
 */

export interface CellResult {
  source?: string;
  output?: Record<string, unknown>;
  written?: string[];
  logs?: { level: string; msg: string }[];
  error?: string;
  ms?: number;
}

export interface RunDetail {
  id: string;
  notebook_id: string;
  status: "running" | "success" | "failed";
  cell_results: Record<string, CellResult>;
  started_at: string;
  finished_at: string | null;
}

export interface OutlineCell {
  cellId: string;
}

interface RawStep {
  id: string;
  kind?: "cell" | "parallel" | string;
  code?: string;
  note?: string;
  lanes?: Array<{
    id?: string;
    label?: string;
    steps?: RawStep[];
  }>;
}

interface RawNotebookDoc {
  id?: string;
  name?: string;
  runtime?: string;
  steps?: RawStep[];
  outputs?: Array<string | { name: string; render?: string }>;
}

let cachedSessionToken: string | null = null;

/**
 * Resets the in-memory cached session token (useful for testing).
 */
export function resetCachedToken(): void {
  cachedSessionToken = null;
}

/**
 * Validates and retrieves required environment variables at runtime.
 */
export function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(`${name} is not set — copy .env.example to .env and fill it in`);
  }
  return v;
}

/**
 * Gets the active session token (in-memory refreshed token or from environment).
 */
function getSessionToken(): string {
  if (cachedSessionToken) {
    return cachedSessionToken;
  }
  return requireEnv("ZAA_SESSION_TOKEN");
}

/**
 * Builds the flattened outline from a notebook document.
 * Flattens nested parallel lanes recursively and preserves cell execution order.
 */
export function outlineOfDocument(document: unknown): OutlineCell[] {
  if (!document || typeof document !== "object") {
    return [];
  }
  const doc = document as RawNotebookDoc;
  const outlines: OutlineCell[] = [];

  function walk(steps?: RawStep[]): void {
    if (!steps || !Array.isArray(steps)) return;
    for (const step of steps) {
      if (step.kind === "parallel") {
        if (Array.isArray(step.lanes)) {
          for (const lane of step.lanes) {
            walk(lane.steps);
          }
        }
        continue;
      }

      // Step is a cell
      const code = step.code ?? "";
      // Cells with empty or whitespace-only code carry intent only and never execute
      if (code.trim().length === 0) {
        continue;
      }

      outlines.push({
        cellId: step.id,
      });
    }
  }

  walk(doc.steps);
  return outlines;
}

/**
 * Retrieves the base URL for the zaatool engine from environment variables.
 */
function getBaseUrl(): string {
  const url = process.env.ZAA_BASE_URL?.trim() || "http://localhost:4000";
  return url.replace(/\/+$/, "");
}

/**
 * HTTP request helper with error handling, network error retries, and auto-refresh on 401 (R2.2).
 */
async function request(
  path: string,
  options: RequestInit = {},
  isRetry = false
): Promise<Response> {
  const baseUrl = getBaseUrl();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${baseUrl}${normalizedPath}`;

  const sessionToken = getSessionToken();
  const defaultHeaders: Record<string, string> = {
    Authorization: `Bearer ${sessionToken}`,
  };

  if (options.body && typeof options.body === "string") {
    defaultHeaders["Content-Type"] = "application/json";
  }

  const mergedHeaders = {
    ...defaultHeaders,
    ...(options.headers as Record<string, string> | undefined),
  };

  const backoffs = [500, 1000, 2000];
  let lastError: unknown;

  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        headers: mergedHeaders,
      });

      // 401 Unauthorized handling (R2.2)
      if (res.status === 401) {
        const username = process.env.ZAA_USERNAME?.trim();
        const password = process.env.ZAA_PASSWORD?.trim();

        if (!isRetry && username && password) {
          // Attempt login without Authorization header
          const loginUrl = `${baseUrl}/api/auth/login`;
          let loginRes: Response;
          try {
            loginRes = await fetch(loginUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ username, password }),
            });
          } catch {
            throw new Error("Authentication failed during auto-refresh: network error");
          }

          if (loginRes.ok) {
            const loginData = (await loginRes.json()) as {
              success?: boolean;
              token?: string;
            };
            if (loginData.token) {
              cachedSessionToken = loginData.token;
              // Retry original request exactly once
              return await request(path, options, true);
            }
          }

          // If login failed (e.g. wrong credentials), throw immediately without looping
          let errorDetail = "invalid credentials";
          try {
            const errBody = (await loginRes.json()) as { error?: string } | undefined;
            if (errBody?.error) errorDetail = errBody.error;
          } catch {
            // ignore
          }
          throw new Error(`Authentication failed during auto-refresh: ${errorDetail}`);
        }

        throw new Error(
          "ZAA_SESSION_TOKEN expired — refresh from localStorage.getItem('zaatool_token') or set ZAA_USERNAME and ZAA_PASSWORD to refresh automatically."
        );
      }

      // Non-2xx responses throw an Error with status code and body
      if (!res.ok) {
        let bodyText = "";
        try {
          bodyText = await res.text();
        } catch {
          bodyText = res.statusText;
        }
        throw new Error(`HTTP ${res.status}: ${bodyText || res.statusText}`);
      }

      return res;
    } catch (err: unknown) {
      // Do not retry 4xx / fatal HTTP errors, missing env errors, or auth failures
      if (
        err instanceof Error &&
        (err.message.includes("ZAA_SESSION_TOKEN") ||
          err.message.includes("is not set") ||
          err.message.includes("Authentication failed") ||
          err.message.startsWith("HTTP "))
      ) {
        throw err;
      }

      // Network errors (e.g. ECONNREFUSED, fetch failed): retry up to 3 times
      lastError = err;
      if (attempt < backoffs.length) {
        await new Promise((resolve) => setTimeout(resolve, backoffs[attempt]));
      }
    }
  }

  throw lastError;
}

/**
 * Polls `getRun` until status is no longer "running", with 250ms interval and 120s timeout.
 */
async function pollRunUntilFinished(
  notebookId: string,
  runId: string,
  pollIntervalMs = 250,
  timeoutMs = 120000
): Promise<RunDetail> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const run = await getRun(notebookId, runId);
    if (run.status !== "running") {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Timeout after ${timeoutMs}ms waiting for run ${runId} to finish`);
}

/**
 * GET /api/notebooks — lists available notebooks.
 */
export async function listNotebooks(): Promise<
  { id: string; name: string; runtime: string }[]
> {
  const res = await request("/api/notebooks");
  const data = (await res.json()) as Array<{ id: string; name: string; runtime: string }>;
  return data.map((nb) => ({
    id: nb.id,
    name: nb.name,
    runtime: nb.runtime,
  }));
}

/**
 * GET /api/notebooks/:id — retrieves raw notebook document.
 */
export async function getNotebook(id: string): Promise<unknown> {
  const res = await request(`/api/notebooks/${encodeURIComponent(id)}`);
  return await res.json();
}

/**
 * GET /api/notebooks/:id/runs/:runId — full unabridged run detail.
 */
export async function getRun(notebookId: string, runId: string): Promise<RunDetail> {
  const res = await request(
    `/api/notebooks/${encodeURIComponent(notebookId)}/runs/${encodeURIComponent(runId)}`
  );
  const data = (await res.json()) as RunDetail;
  return data;
}

/**
 * GET /api/notebooks/:id/runs — lists runs newest first.
 */
export async function listRuns(
  notebookId: string
): Promise<{ id: string; status: string; started_at: string }[]> {
  const res = await request(`/api/notebooks/${encodeURIComponent(notebookId)}/runs`);
  const data = (await res.json()) as Array<{
    id: string;
    status: string;
    started_at: string;
  }>;
  return data.map((r) => ({
    id: r.id,
    status: r.status,
    started_at: r.started_at,
  }));
}

/**
 * Runs entire notebook, polls until finished, returns final RunDetail.
 */
export async function runNotebook(
  notebookId: string,
  args?: Record<string, unknown>
): Promise<RunDetail> {
  const body: Record<string, unknown> = {};
  if (args) {
    body.args = args;
  }

  const startRes = await request(`/api/notebooks/${encodeURIComponent(notebookId)}/run`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const startData = (await startRes.json()) as { status: string; runId: string };
  const runId = startData.runId;

  return await pollRunUntilFinished(notebookId, runId);
}

/**
 * Runs a single cell with given scope, polls until finished, returns CellResult.
 */
export async function runCell(
  notebookId: string,
  cellId: string,
  input: Record<string, unknown>
): Promise<CellResult> {
  const body = {
    cellId,
    input,
  };

  const startRes = await request(`/api/notebooks/${encodeURIComponent(notebookId)}/run`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const startData = (await startRes.json()) as { status: string; runId: string };
  const runId = startData.runId;

  const runDetail = await pollRunUntilFinished(notebookId, runId);
  const cellResult = runDetail.cell_results?.[cellId];
  if (cellResult) {
    return cellResult;
  }

  return {
    error: (runDetail as { error?: string }).error || "Cell result not found in run detail",
  };
}

/**
 * Document cell execution order (parallel lanes flattened).
 */
export async function outline(notebookId: string): Promise<OutlineCell[]> {
  const doc = await getNotebook(notebookId);
  return outlineOfDocument(doc);
}
