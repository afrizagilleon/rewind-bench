import { describe, it, expect } from "vitest";
import { generateHtmlReport } from "../src/report";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const results = (f: string): string => join(process.cwd(), "results", f);

describe("report generator", () => {
  const metricsPath = results("metrics.json");
  const auditPath = results("symptom-audit.json");

  const build = (): string => {
    const metrics = JSON.parse(readFileSync(metricsPath, "utf8"));
    const audit = JSON.parse(readFileSync(auditPath, "utf8"));
    // Shape only — the real split is computed from arms.jsonl in main().
    const visible = { visible: [25, 26, 25], invisible: [2, 2, 4] };
    return generateHtmlReport(metrics, audit, visible);
  };

  it("has the inputs it needs", () => {
    expect(existsSync(metricsPath)).toBe(true);
    expect(existsSync(auditPath)).toBe(true);
  });

  it("is self-contained — nothing is fetched at render time", () => {
    const html = build();
    expect(html).not.toContain("<script src=");
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("cdn.");
    expect(html).not.toContain("unpkg.com");
    expect(html).not.toMatch(/<link[^>]+rel=["']stylesheet["']/);
    // The only outbound link is the repo, and it is a link, not a dependency.
    const urls = [...html.matchAll(/https?:\/\/[^"'\s)]+/g)].map((m) => m[0]);
    expect(urls.every((u) => u.includes("github.com/afrizagilleon"))).toBe(true);
  });

  it("carries the verified determinism figures", () => {
    const html = build();
    expect(html).toContain("0.8942");
    expect(html).toContain("93 of 104");
    expect(html).toContain("1,040");
  });

  it("reports both models side by side and never pools the corpora", () => {
    const html = build();
    expect(html).toContain("DeepSeek-V4-Flash");
    expect(html).toContain("GLM-5.2");
    expect(html).toContain("never pooled");
  });

  it("states the bounds rather than burying them", () => {
    const html = build();
    expect(html).toContain("What this does not show");
    expect(html).toContain("none is claimed");
  });

  it("shows the held-out failure as two disagreeing digests", () => {
    const html = build();
    expect(html).toContain("cmp is-same");
    expect(html).toContain("cmp is-diff");
    expect(html).toContain("does not match");
  });

  it("derives its figures from metrics.json rather than hard-coding them", () => {
    const metrics = JSON.parse(readFileSync(metricsPath, "utf8"));
    const audit = JSON.parse(readFileSync(auditPath, "utf8"));
    const visible = { visible: [1, 2, 3], invisible: [4, 5, 6] };

    const bumped = structuredClone(metrics);
    bumped.designed.arms.rewind.luckyPassCount = 99;
    const html = generateHtmlReport(bumped, audit, visible);
    expect(html).toContain("99 of");
  });

  it("writes English only", () => {
    const html = build();
    const prose = html.replace(/<style>[\s\S]*?<\/style>/g, "");
    expect(prose).not.toMatch(/\b(yang|dengan|adalah|tidak|untuk|dari|corpus terancang)\b/i);
  });
});
