import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  listNotebooks,
  getNotebook,
  getRun,
  listRuns,
  runNotebook,
  runCell,
  outline,
  outlineOfDocument,
  requireEnv,
  resetCachedToken,
  type RunDetail,
} from "../src/client";

const fixturesDir = join(__dirname, "..", "fixtures");

function readFixture<T = unknown>(filename: string): T {
  const content = readFileSync(join(fixturesDir, filename), "utf8");
  return JSON.parse(content) as T;
}

describe("R2.1 Client — Fixtures Structure", () => {
  it("parses run-detail-parallel.json with 8 cells in cell_results", () => {
    const detail = readFixture<RunDetail>("run-detail-parallel.json");
    expect(detail.id).toBe("563a15e9-21c8-4123-84e3-1ad2480a68c6");
    expect(detail.status).toBe("success");
    const cellIds = Object.keys(detail.cell_results);
    expect(cellIds).toHaveLength(8);

    for (const cellId of cellIds) {
      const result = detail.cell_results[cellId];
      expect(result).toBeDefined();
      expect(typeof result.source).toBe("string");
      expect(typeof result.output).toBe("object");
      expect(Array.isArray(result.written)).toBe(true);
      expect(result.written?.length).toBeGreaterThan(0);
    }
  });

  it("parses run-detail-simple.json with 2 cells", () => {
    const detail = readFixture<RunDetail>("run-detail-simple.json");
    expect(detail.status).toBe("success");
    const cellIds = Object.keys(detail.cell_results);
    expect(cellIds).toHaveLength(2);
    expect(cellIds).toContain("fetch-rates");
    expect(cellIds).toContain("simulate-archive");
  });

  it("parses run-detail-single-cell.json with 1 cell", () => {
    const detail = readFixture<RunDetail>("run-detail-single-cell.json");
    expect(detail.status).toBe("success");
    expect(Object.keys(detail.cell_results)).toHaveLength(1);
    expect(detail.cell_results["fetch-rates"]).toBeDefined();
  });

  it("parses notebooks-list.json and runs-list.json", () => {
    const notebooks = readFixture<unknown[]>("notebooks-list.json");
    expect(notebooks.length).toBe(12);

    const runs = readFixture<unknown[]>("runs-list.json");
    expect(runs.length).toBe(4);
  });
});

describe("R2.1 Client — Execution Order Flattening (outline)", () => {
  it("extracts outline from notebook-doc-simple.json in correct order", () => {
    const doc = readFixture("notebook-doc-simple.json");
    const cells = outlineOfDocument(doc);
    expect(cells).toEqual([
      { cellId: "fetch-rates" },
      { cellId: "simulate-archive" },
    ]);
  });

  it("extracts outline from notebook-doc-parallel.json with 3 levels of nested lanes in exact execution order (8 cells)", () => {
    const doc = readFixture("notebook-doc-parallel.json");
    const cells = outlineOfDocument(doc);
    expect(cells).toHaveLength(8);

    const expectedOrder = [
      "a547f958-3a34-4d16-83d7-d38565025db3", // level 0 first cell
      "d4f80f1b-b2c8-4e7c-a87c-5103d6b386ac", // lane A level 1
      "1a28481b-ce35-47ed-982f-a60658eb91e9", // lane B level 1
      "046fe5be-e251-4c19-8eed-ed023a359abb", // lane B.1 level 2
      "056af417-d3eb-41dd-93fd-8ee3dc8a0d01", // lane B.2 level 2
      "4fcdea6b-5b72-4986-b358-b642bfe6764f", // lane B.2.i level 3
      "7ca0c627-c5b2-40be-8d58-02885a5290a2", // lane B.2.ii level 3
      "673ad773-5fe5-405f-9857-24c8764312f0", // level 0 summary cell
    ];

    expect(cells.map((c) => c.cellId)).toEqual(expectedOrder);
  });

  it("skips cells with empty or whitespace-only code", () => {
    const doc = {
      steps: [
        { id: "c1", kind: "cell", code: "return { a: 1 };" },
        { id: "c-empty", kind: "cell", code: "   \n\t  " },
        { id: "c2", kind: "cell", code: "return { b: 2 };" },
      ],
    };
    const cells = outlineOfDocument(doc);
    expect(cells).toEqual([
      { cellId: "c1" },
      { cellId: "c2" },
    ]);
  });
});

describe("R2.1 Client — Configuration Validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetCachedToken();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetCachedToken();
  });

  it("requireEnv throws 'is not set' error when env var is missing or empty", () => {
    delete process.env.TEST_MISSING_VAR;
    expect(() => requireEnv("TEST_MISSING_VAR")).toThrow(
      "TEST_MISSING_VAR is not set — copy .env.example to .env and fill it in"
    );

    process.env.TEST_EMPTY_VAR = "   ";
    expect(() => requireEnv("TEST_EMPTY_VAR")).toThrow(
      "TEST_EMPTY_VAR is not set — copy .env.example to .env and fill it in"
    );
  });

  it("request throws 'is not set' error when ZAA_SESSION_TOKEN is empty, not 'expired'", async () => {
    delete process.env.ZAA_SESSION_TOKEN;
    await expect(listNotebooks()).rejects.toThrow(
      "ZAA_SESSION_TOKEN is not set — copy .env.example to .env and fill it in"
    );
    await expect(listNotebooks()).rejects.not.toThrow(/expired/i);
  });
});

describe("R2.1 Client — HTTP Endpoints with Stubbed Fetch", () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetCachedToken();
    process.env.ZAA_BASE_URL = "http://localhost:4000";
    process.env.ZAA_SESSION_TOKEN = "test-session-jwt";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
    resetCachedToken();
    vi.restoreAllMocks();
  });

  it("listNotebooks calls GET /api/notebooks with Bearer JWT", async () => {
    const mockList = readFixture("notebooks-list.json");
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockList,
    } as Response);

    const notebooks = await listNotebooks();
    expect(notebooks.length).toBe(12);
    expect(notebooks[0]).toEqual({
      id: "8aee2070-007a-4a67-984e-3df3e5c641b1",
      name: "archive-exchange-rates",
      runtime: "node",
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:4000/api/notebooks",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-session-jwt",
        }),
      })
    );
  });

  it("getNotebook calls GET /api/notebooks/:id", async () => {
    const mockDoc = readFixture("notebook-doc-simple.json");
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockDoc,
    } as Response);

    const doc = (await getNotebook("8aee2070-007a-4a67-984e-3df3e5c641b1")) as {
      id: string;
      name: string;
    };
    expect(doc.id).toBe("8aee2070-007a-4a67-984e-3df3e5c641b1");
    expect(doc.name).toBe("archive-exchange-rates");
  });

  it("getRun calls GET /api/notebooks/:id/runs/:runId", async () => {
    const mockRun = readFixture("run-detail-parallel.json");
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockRun,
    } as Response);

    const run = await getRun(
      "52cc6e6b-26e3-4407-b60a-13f000679449",
      "563a15e9-21c8-4123-84e3-1ad2480a68c6"
    );
    expect(run.id).toBe("563a15e9-21c8-4123-84e3-1ad2480a68c6");
    expect(run.status).toBe("success");
    expect(Object.keys(run.cell_results)).toHaveLength(8);
  });

  it("listRuns calls GET /api/notebooks/:id/runs", async () => {
    const mockRuns = readFixture("runs-list.json");
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockRuns,
    } as Response);

    const runs = await listRuns("52cc6e6b-26e3-4407-b60a-13f000679449");
    expect(runs.length).toBe(4);
    expect(runs[0].id).toBe("563a15e9-21c8-4123-84e3-1ad2480a68c6");
    expect(runs[0].status).toBe("success");
  });

  it("runNotebook starts run and polls until completion", async () => {
    const mockRunRunning = {
      id: "run-123",
      notebook_id: "nb-1",
      status: "running",
      cell_results: {},
      started_at: "2026-08-15T00:00:00Z",
      finished_at: null,
    };
    const mockRunSuccess = {
      id: "run-123",
      notebook_id: "nb-1",
      status: "success",
      cell_results: {
        c1: { output: { x: 1 }, written: ["x"], ms: 10 },
      },
      started_at: "2026-08-15T00:00:00Z",
      finished_at: "2026-08-15T00:00:01Z",
    };

    let fetchCount = 0;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      fetchCount++;
      if (url.endsWith("/run")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "started", runId: "run-123" }),
        } as Response;
      }
      if (url.endsWith("/runs/run-123")) {
        if (fetchCount === 2) {
          return {
            ok: true,
            status: 200,
            json: async () => mockRunRunning,
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => mockRunSuccess,
        } as Response;
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const run = await runNotebook("nb-1", { foo: "bar" });
    expect(run.status).toBe("success");
    expect(run.cell_results.c1.output).toEqual({ x: 1 });
  });

  it("runCell starts cell run and returns CellResult", async () => {
    const mockRunSuccess = {
      id: "run-cell-1",
      notebook_id: "nb-1",
      status: "success",
      cell_results: {
        "target-cell": {
          source: "return { double: inputs.n * 2 };",
          output: { double: 10 },
          written: ["double"],
          ms: 15,
        },
      },
      started_at: "2026-08-15T00:00:00Z",
      finished_at: "2026-08-15T00:00:01Z",
    };

    global.fetch = vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url.endsWith("/run")) {
        const body = JSON.parse((opts?.body as string) || "{}");
        expect(body.cellId).toBe("target-cell");
        expect(body.input).toEqual({ n: 5 });
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "started", runId: "run-cell-1" }),
        } as Response;
      }
      if (url.endsWith("/runs/run-cell-1")) {
        return {
          ok: true,
          status: 200,
          json: async () => mockRunSuccess,
        } as Response;
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const cellResult = await runCell("nb-1", "target-cell", { n: 5 });
    expect(cellResult.output).toEqual({ double: 10 });
    expect(cellResult.written).toEqual(["double"]);
  });

  it("outline fetches document and returns outline cells", async () => {
    const mockDoc = readFixture("notebook-doc-simple.json");
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockDoc,
    } as Response);

    const outlineCells = await outline("8aee2070-007a-4a67-984e-3df3e5c641b1");
    expect(outlineCells).toEqual([
      { cellId: "fetch-rates" },
      { cellId: "simulate-archive" },
    ]);
  });
});

describe("R2.1 & R2.2 Client — Auth, Auto-Refresh & Error Handling", () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetCachedToken();
    process.env.ZAA_BASE_URL = "http://localhost:4000";
    process.env.ZAA_SESSION_TOKEN = "initial-session-jwt";
    delete process.env.ZAA_USERNAME;
    delete process.env.ZAA_PASSWORD;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
    resetCachedToken();
    vi.restoreAllMocks();
  });

  it("401 without credentials throws fatal Error mentioning both remedies (R2.2 acceptance)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "Unauthorized",
    } as Response);

    await expect(listNotebooks()).rejects.toThrow(
      "ZAA_SESSION_TOKEN expired — refresh from localStorage.getItem('zaatool_token') or set ZAA_USERNAME and ZAA_PASSWORD to refresh automatically."
    );
  });

  it("401 with credentials triggers auto-refresh and succeeds on retry (R2.2 acceptance)", async () => {
    process.env.ZAA_USERNAME = "my-user";
    process.env.ZAA_PASSWORD = "my-password";

    let requestCount = 0;
    global.fetch = vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
      requestCount++;
      if (url === "http://localhost:4000/api/notebooks") {
        const authHeader = (opts?.headers as Record<string, string>)?.Authorization;
        if (authHeader === "Bearer initial-session-jwt") {
          return {
            ok: false,
            status: 401,
            statusText: "Unauthorized",
            text: async () => "Unauthorized",
          } as Response;
        }
        if (authHeader === "Bearer refreshed-session-jwt") {
          return {
            ok: true,
            status: 200,
            json: async () => [{ id: "nb-1", name: "nb1", runtime: "node" }],
          } as Response;
        }
      }
      if (url === "http://localhost:4000/api/auth/login") {
        expect(opts?.headers).not.toHaveProperty("Authorization");
        const body = JSON.parse((opts?.body as string) || "{}");
        expect(body).toEqual({ username: "my-user", password: "my-password" });
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, token: "refreshed-session-jwt" }),
        } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const notebooks = await listNotebooks();
    expect(notebooks).toHaveLength(1);
    expect(notebooks[0].id).toBe("nb-1");
    // Exactly 3 fetch calls: 1st notebooks (401) -> login (200) -> 2nd notebooks retry with new token (200)
    expect(requestCount).toBe(3);
  });

  it("wrong credentials throws after one attempt without looping (R2.2 acceptance)", async () => {
    process.env.ZAA_USERNAME = "wrong-user";
    process.env.ZAA_PASSWORD = "wrong-password";

    let fetchCount = 0;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      fetchCount++;
      if (url === "http://localhost:4000/api/notebooks") {
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          text: async () => "Unauthorized",
        } as Response;
      }
      if (url === "http://localhost:4000/api/auth/login") {
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          json: async () => ({ error: "Invalid username or password" }),
        } as Response;
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(listNotebooks()).rejects.toThrow(
      "Authentication failed during auto-refresh: Invalid username or password"
    );
    // Exactly 2 calls: original request + 1 login attempt
    expect(fetchCount).toBe(2);
  });

  it("404 response throws Error rather than returning undefined", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => JSON.stringify({ error: "Run not found" }),
    } as Response);

    await expect(getRun("nb-1", "non-existent-run")).rejects.toThrow(/HTTP 404/);
  });

  it("retries on network errors up to 3 times", async () => {
    let attempts = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts < 3) {
        throw new TypeError("fetch failed");
      }
      return {
        ok: true,
        status: 200,
        json: async () => [],
      } as Response;
    });

    const result = await listNotebooks();
    expect(result).toEqual([]);
    expect(attempts).toBe(3);
  });

  it("does NOT retry 4xx client errors", async () => {
    let attempts = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      attempts++;
      return {
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: async () => "Invalid input",
      } as Response;
    });

    await expect(listNotebooks()).rejects.toThrow(/HTTP 400/);
    expect(attempts).toBe(1);
  });
});
