import { describe, it, expect } from "vitest";
import { generateHtmlReport } from "../src/report";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

describe("report.ts HTML generator", () => {
  it("generates a self-contained HTML report with all required sections", () => {
    const metricsPath = join(process.cwd(), "results", "metrics.json");
    expect(existsSync(metricsPath)).toBe(true);

    const metricsData = JSON.parse(readFileSync(metricsPath, "utf8"));
    const html = generateHtmlReport(metricsData);

    // 1. Basic HTML structure
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html lang=\"id\">");
    expect(html).toContain("</html>");

    // 2. Zero external scripts or CDNs
    expect(html).not.toContain("<script src=");
    expect(html).not.toContain("https://cdn.");
    expect(html).not.toContain("https://fonts.googleapis.com");
    expect(html).not.toContain("https://unpkg.com");
    expect(html).not.toContain("https://cdnjs.");

    // 3. Section 1: H4 Determinism Census
    expect(html).toContain("H4 — Determinism Census");
    expect(html).toContain("0.8942");
    expect(html).toContain("93 / 104");
    expect(html).toContain("1.040");
    expect(html).toContain("Wall-Clock Time");
    expect(html).toContain("Network I/O");
    expect(html).toContain("Unknown / Race Condition");
    expect(html).toContain("PRNG Unseeded");

    // 4. Section 2: Two Corpora Side-by-Side
    expect(html).toContain("Corpus Terancang (Designed)");
    expect(html).toContain("Corpus Insidental (Real-World)");

    // 5. Section 3: Genuine Resolution & McNemar Paired Tests
    expect(html).toContain("McNemar");
    expect(html).toContain("exact binomial");
    expect(html).toContain("1.0000");

    // 6. Section 4: Cost & SVG Bar Chart
    expect(html).toContain("<svg viewBox=");
    expect(html).toContain("Amortized Tokens / Genuine Fix");

    // 7. Section 5: Lucky-pass case study b143f174
    expect(html).toContain("b143f174");
    expect(html).toContain("let penalty = a.missedPayments * 22;");
    expect(html).toContain("let penalty = a.missedPayments * 23;");
    expect(html).toContain("let bonus = Math.min(a.creditHistoryYears * 2.5 + a.missedPayments, 25);");

    // 8. Section 6: Limitations
    expect(html).toContain("Keterbatasan Metodologi");
    expect(html).toContain("PQI Arm A Bernilai 1,0 Secara Konstruksi");
    expect(html).toContain("zz-uji-20-cell");

    // 9. Section 7: GLM Cross-Model Section
    expect(html).toContain("Evaluasi Lintas-Model (GLM-5.2)");
  });
});
