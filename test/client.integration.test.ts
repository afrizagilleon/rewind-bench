import { describe, it, expect } from "vitest";
import {
  listNotebooks,
  getNotebook,
  getRun,
  runNotebook,
  runCell,
  outline,
} from "../src/client";

// Probe live zaatool engine and session token validity
let hasValidSession = false;

const baseUrl = process.env.ZAA_BASE_URL;
const sessionToken = process.env.ZAA_SESSION_TOKEN;

if (baseUrl && sessionToken) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/notebooks`, {
      headers: {
        Authorization: `Bearer ${sessionToken}`,
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    hasValidSession = res.ok;
  } catch {
    hasValidSession = false;
  }
}

describe.skipIf(!hasValidSession)(
  "R2 Client — Integration Tests (skipped when ZAA_BASE_URL is empty or token is invalid)",
  () => {
    it("listNotebooks returns at least 1 notebook from live engine", async () => {
      const notebooks = await listNotebooks();
      expect(notebooks.length).toBeGreaterThanOrEqual(1);
      expect(notebooks[0]).toHaveProperty("id");
      expect(notebooks[0]).toHaveProperty("name");
      expect(notebooks[0]).toHaveProperty("runtime");
    });

    it("getNotebook and outline work for a live notebook", async () => {
      const notebooks = await listNotebooks();
      const firstId = notebooks[0].id;

      const doc = (await getNotebook(firstId)) as { id: string; name: string };
      expect(doc).toBeDefined();
      expect(doc.id).toBe(firstId);

      const outlineCells = await outline(firstId);
      expect(Array.isArray(outlineCells)).toBe(true);
    });

    it("getRun with invalid runId throws an Error (non-2xx)", async () => {
      const notebooks = await listNotebooks();
      const firstId = notebooks[0].id;

      await expect(getRun(firstId, "non-existent-run-id-99999")).rejects.toThrow(
        /HTTP/
      );
    });

    it("runNotebook runs simple notebook and returns successful RunDetail", async () => {
      const notebooks = await listNotebooks();
      const simple =
        notebooks.find((nb) => nb.name === "archive-exchange-rates") ||
        notebooks[0];

      const run = await runNotebook(simple.id);
      expect(run.status).toBe("success");
      expect(Object.keys(run.cell_results).length).toBeGreaterThan(0);
    });

    it("runCell executes a single cell with provided input", async () => {
      const notebooks = await listNotebooks();
      const simple =
        notebooks.find((nb) => nb.name === "archive-exchange-rates") ||
        notebooks[0];

      const outlineCells = await outline(simple.id);
      if (outlineCells.length > 0) {
        const targetCellId = outlineCells[0].cellId;
        const cellResult = await runCell(simple.id, targetCellId, {});
        expect(cellResult).toBeDefined();
      }
    });
  }
);
