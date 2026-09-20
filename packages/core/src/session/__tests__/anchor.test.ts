import { describe, it, expect } from "vitest";
import {
  normalizeUnifiedAnchor,
  isPdfNodeAnchor,
  isContentNodeAnchor,
} from "../anchor.js";

describe("normalizeUnifiedAnchor", () => {
  it("normalizes a valid pdf anchor", () => {
    expect(
      normalizeUnifiedAnchor({ kind: "pdf", page: 4, quote: "x", section: "3.2" }),
    ).toEqual({ kind: "pdf", page: 4, quote: "x", section: "3.2" });
  });

  it("coerces string pages and clamps oversized strings", () => {
    const anchor = normalizeUnifiedAnchor({
      kind: "pdf",
      page: "7",
      quote: "a".repeat(5000),
      section: "b".repeat(2000),
    });
    expect(anchor).toEqual({
      kind: "pdf",
      page: 7,
      quote: "a".repeat(2000),
      section: "b".repeat(500),
    });
  });

  it("rejects pdf anchors without a positive integer page", () => {
    expect(normalizeUnifiedAnchor({ kind: "pdf", page: 0, quote: "x" })).toBeNull();
    expect(normalizeUnifiedAnchor({ kind: "pdf", page: -2, quote: "x" })).toBeNull();
    expect(normalizeUnifiedAnchor({ kind: "pdf", page: 2.5, quote: "x" })).toBeNull();
    expect(normalizeUnifiedAnchor({ kind: "pdf", quote: "x" })).toBeNull();
  });

  it("normalizes a valid content anchor", () => {
    expect(
      normalizeUnifiedAnchor({ kind: "content", nodeId: "n1", quote: "KL divergence" }),
    ).toEqual({ kind: "content", nodeId: "n1", quote: "KL divergence" });
  });

  it("rejects content anchors without a nodeId", () => {
    expect(normalizeUnifiedAnchor({ kind: "content", quote: "x" })).toBeNull();
    expect(normalizeUnifiedAnchor({ kind: "content", nodeId: "  " })).toBeNull();
    expect(normalizeUnifiedAnchor({ kind: "content", nodeId: 42 })).toBeNull();
  });

  it("rejects unknown kinds and non-objects", () => {
    expect(normalizeUnifiedAnchor({ kind: "chapter", page: 1 })).toBeNull();
    expect(normalizeUnifiedAnchor(null)).toBeNull();
    expect(normalizeUnifiedAnchor(undefined)).toBeNull();
    expect(normalizeUnifiedAnchor("pdf")).toBeNull();
    expect(normalizeUnifiedAnchor([])).toBeNull();
  });

  it("type guards discriminate the two variants", () => {
    const pdf = normalizeUnifiedAnchor({ kind: "pdf", page: 1, quote: "q", section: "" });
    const content = normalizeUnifiedAnchor({ kind: "content", nodeId: "n", quote: "q" });
    expect(pdf && isPdfNodeAnchor(pdf)).toBe(true);
    expect(content && isContentNodeAnchor(content)).toBe(true);
    expect(pdf && isContentNodeAnchor(pdf)).toBe(false);
  });
});
