import { describe, it, expect } from "vitest";
import { parseModelAction } from "../src/agent";

describe("R6 Agent — Protocol Action Parsing", () => {
  it("parses pure fenced JSON block", () => {
    const raw = "```json\n{\"action\": \"notebook_read\", \"cell\": \"c1\"}\n```";
    const parsed = parseModelAction(raw);
    expect(parsed).toEqual({ action: "notebook_read", cell: "c1" });
  });

  it("parses fenced code block without json keyword", () => {
    const raw = "```\n{\"action\": \"finish\", \"reason\": \"all good\"}\n```";
    const parsed = parseModelAction(raw);
    expect(parsed).toEqual({ action: "finish", reason: "all good" });
  });

  it("parses raw JSON string with leading or trailing explanations", () => {
    const raw = "Here is my action:\n```json\n{\"action\": \"notebook_edit_cell\", \"cell\": \"c1\", \"code\": \"return { a: 1 };\"}\n```\nDone.";
    const parsed = parseModelAction(raw);
    expect(parsed).toEqual({ action: "notebook_edit_cell", cell: "c1", code: "return { a: 1 };" });
  });

  it("returns null for malformed or non-action JSON", () => {
    expect(parseModelAction("Just plain text without json")).toBeNull();
    expect(parseModelAction("```json\n{\"foo\": \"bar\"}\n```")).toBeNull();
  });
});
