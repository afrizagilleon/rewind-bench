import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

describe("run-demo.ts structure and integrity", () => {
  it("has fixtures for designed risk assessment and heldout", () => {
    const fixturePath = join(process.cwd(), "fixtures", "designed", "rb-designed-risk-assessment.json");
    const heldoutPath = join(process.cwd(), "fixtures", "designed", "rb-designed-risk-assessment.heldout.json");

    expect(existsSync(fixturePath)).toBe(true);
    expect(existsSync(heldoutPath)).toBe(true);

    const doc = JSON.parse(readFileSync(fixturePath, "utf8"));
    expect(doc.name).toBe("rb-designed-risk-assessment");
    expect(doc.steps.length).toBe(7);

    const cell3 = doc.steps.find((s: any) => s.id === "95afd5ff-4bdd-4d01-b76c-86a312f526f2");
    expect(cell3).toBeDefined();
    expect(cell3.code).toContain("if (capacityScore > 100) capacityScore = 100;");

    const cell4 = doc.steps.find((s: any) => s.id === "b143f174-8e7c-455e-984b-efff641fbf35");
    expect(cell4).toBeDefined();
    expect(cell4.code).toContain("penalty = a.missedPayments * 22;");
  });

  it("does not mutate corpus result files", () => {
    const mutationsPath = join(process.cwd(), "results", "mutations.jsonl");
    const armsPath = join(process.cwd(), "results", "arms.jsonl");
    const metricsPath = join(process.cwd(), "results", "metrics.json");

    expect(existsSync(mutationsPath)).toBe(true);
    expect(existsSync(armsPath)).toBe(true);
    expect(existsSync(metricsPath)).toBe(true);
  });
});
