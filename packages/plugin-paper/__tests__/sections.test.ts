/**
 * Unit tests for paper section extraction (services/sections.ts).
 *
 * Covers the three heading sources (numbered regex, markdown headings, bare
 * section names), false-positive filters, outline cross-checking with dest
 * page numbers, page-index fallback, dedupe, and title normalization.
 */
import { describe, it, expect } from "vitest";
import {
  extractPaperSections,
  extractHeadingsFromMarkdown,
  normalizeTitle,
  normalizeCase,
  type OutlineItemLike,
  type PageIndexEntry,
} from "../services/sections.js";

// ---------------------------------------------------------------------------
// normalizeTitle / normalizeCase
// ---------------------------------------------------------------------------

describe("normalizeTitle", () => {
  it("is case/punctuation/markdown-insensitive", () => {
    expect(normalizeTitle("3.1 Introduction")).toBe("3 1 introduction");
    expect(normalizeTitle("3.1 INTRODUCTION")).toBe("3 1 introduction");
    expect(normalizeTitle("**3.1** *Introduction*")).toBe("3 1 introduction");
    expect(normalizeTitle("[Motivation](#sec-motivation)")).toBe("motivation");
  });
});

describe("normalizeCase", () => {
  it("title-cases ALL-CAPS titles", () => {
    expect(normalizeCase("INTRODUCTION AND RELATED WORK")).toBe(
      "Introduction and Related Work",
    );
    expect(normalizeCase("3 RELATED WORK")).toBe("3 Related Work");
  });

  it("leaves mixed-case titles untouched", () => {
    expect(normalizeCase("Attention Is All You Need")).toBe("Attention Is All You Need");
    expect(normalizeCase("GPT-4 Technical Report")).toBe("GPT-4 Technical Report");
  });

  it("preserves roman-numeral section heads", () => {
    expect(normalizeCase("II BACKGROUND")).toBe("II Background");
    expect(normalizeCase("IV Experiments")).toBe("IV Experiments");
  });
});

// ---------------------------------------------------------------------------
// extractHeadingsFromMarkdown
// ---------------------------------------------------------------------------

describe("extractHeadingsFromMarkdown", () => {
  it("maps # count to level with correct 1-based lines", () => {
    const md = "# Title\n\nintro\n\n## Method\n\n### Details\n";
    expect(extractHeadingsFromMarkdown(md)).toEqual([
      { line: 1, level: 1, title: "Title" },
      { line: 5, level: 2, title: "Method" },
      { line: 7, level: 3, title: "Details" },
    ]);
  });

  it("skips headings inside fenced code blocks", () => {
    const md = "```md\n# Not a heading\n```\n\n# Real heading\n";
    expect(extractHeadingsFromMarkdown(md)).toEqual([
      { line: 5, level: 1, title: "Real heading" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Numbered headings (source a)
// ---------------------------------------------------------------------------

describe("numbered headings", () => {
  it("maps segment count to level", () => {
    const md = "3 Methodology\n\n3.1 Introduction\n\n3.1.2 Details\n\nA.2 Proofs\n\nIV Experiments\n";
    expect(extractPaperSections(md)).toEqual([
      { line: 1, level: 1, title: "3 Methodology" },
      { line: 3, level: 2, title: "3.1 Introduction" },
      { line: 5, level: 3, title: "3.1.2 Details" },
      { line: 7, level: 2, title: "A.2 Proofs" },
      { line: 9, level: 1, title: "IV Experiments" },
    ]);
  });

  it("prefers the numbered level over the markdown # count", () => {
    expect(extractPaperSections("#### A.2 Proofs\n")).toEqual([
      { line: 1, level: 2, title: "A.2 Proofs" },
    ]);
  });

  it("normalizes ALL-CAPS numbered titles", () => {
    expect(extractPaperSections("3 RELATED WORK\n")).toEqual([
      { line: 1, level: 1, title: "3 Related Work" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// False-positive filters
// ---------------------------------------------------------------------------

describe("false-positive filters", () => {
  it("rejects sentence-like lines ending with a period", () => {
    expect(extractPaperSections("3.1 We propose a new method.\n")).toEqual([]);
  });

  it("rejects 'I think that …' sentence continuations", () => {
    expect(extractPaperSections("I think therefore I am\n")).toEqual([]);
  });

  it("rejects lowercase single-letter heads (PDF wrap artifacts)", () => {
    expect(
      extractPaperSections("a TEE cannot be tampered with by other processes, even\n"),
    ).toEqual([]);
  });

  it("rejects lowercase bare-name fragments (wrapped sentence tails)", () => {
    expect(extractPaperSections("approach.\n")).toEqual([]);
  });

  it("rejects over-long lines", () => {
    const longLine = `3.1 ${"x".repeat(160)}`;
    expect(extractPaperSections(longLine)).toEqual([]);
  });

  it("rejects bare numbers and body prose", () => {
    expect(extractPaperSections("42\n\nWe evaluate our method on two benchmarks.\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bare section names (source b)
// ---------------------------------------------------------------------------

describe("bare section names", () => {
  it("matches whole-line well-known names at level 1", () => {
    const md = "Abstract\n\nIntroduction\n\nRelated Work\n\nEvaluation\n\nReferences\n";
    expect(extractPaperSections(md)).toEqual([
      { line: 1, level: 1, title: "Abstract" },
      { line: 3, level: 1, title: "Introduction" },
      { line: 5, level: 1, title: "Related Work" },
      { line: 7, level: 1, title: "Evaluation" },
      { line: 9, level: 1, title: "References" },
    ]);
  });

  it("tolerates trailing punctuation", () => {
    expect(extractPaperSections("Evaluation:\n")).toEqual([
      { line: 1, level: 1, title: "Evaluation:" },
    ]);
  });

  it("forces References to level 1 even as a markdown heading", () => {
    expect(extractPaperSections("# References\n")).toEqual([
      { line: 1, level: 1, title: "References" },
    ]);
  });

  it("does not match mid-sentence occurrences", () => {
    expect(extractPaperSections("In this section we describe the evaluation setup.\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

describe("dedupe", () => {
  it("merges the same heading within ±3 lines", () => {
    const md = "## 3.1 Introduction\n\n3.1 Introduction\n\n# 5 Conclusion\n";
    expect(extractPaperSections(md)).toEqual([
      { line: 1, level: 2, title: "3.1 Introduction" },
      { line: 5, level: 1, title: "5 Conclusion" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// PDF outline cross-check (source c)
// ---------------------------------------------------------------------------

describe("outline cross-check", () => {
  const outline: OutlineItemLike[] = [
    { title: "1 Introduction", dest: [0, { name: "XYZ" }], items: [] },
    { title: "3 Method", dest: [4, { name: "XYZ" }], items: [] },
  ];

  it("adopts outline wording and numeric dest pages (0-based → 1-based)", () => {
    const md = "# 1 Introduction\n\nSome text.\n\n# 3 Method\n";
    const sections = extractPaperSections(md, { outline });
    expect(sections).toEqual([
      { line: 1, level: 1, title: "1 Introduction", page: 1 },
      { line: 5, level: 1, title: "3 Method", page: 5 },
    ]);
  });

  it("matches nested outline items via flattening", () => {
    const nested: OutlineItemLike[] = [
      { title: "1 Introduction", dest: [0], items: [] },
      {
        title: "2 Background",
        dest: [2],
        items: [{ title: "2.1 Notation", dest: [3], items: [] }],
      },
    ];
    const md = "# 2 Background\n\ntext\n\n## 2.1 Notation\n";
    expect(extractPaperSections(md, { outline: nested })).toEqual([
      { line: 1, level: 1, title: "2 Background", page: 3 },
      { line: 5, level: 2, title: "2.1 Notation", page: 4 },
    ]);
  });

  it("uses fuzzy matches for page numbers only (keeps section title)", () => {
    const fuzzy: OutlineItemLike[] = [{ title: "Motivation", dest: [1], items: [] }];
    const sections = extractPaperSections("# 1.1 Motivation\n", { outline: fuzzy });
    expect(sections).toEqual([{ line: 1, level: 2, title: "1.1 Motivation", page: 2 }]);
  });

  it("ignores {num, gen} reference dests (no page, best-effort)", () => {
    const refDest: OutlineItemLike[] = [
      { title: "3 Method", dest: { num: 1, gen: 0 }, items: [] },
    ];
    const sections = extractPaperSections("# 3 Method\n", { outline: refDest });
    expect(sections).toEqual([{ line: 1, level: 1, title: "3 Method" }]);
  });
});

// ---------------------------------------------------------------------------
// Page-index fallback
// ---------------------------------------------------------------------------

describe("page-index fallback", () => {
  const pageIndex: PageIndexEntry[] = [
    { page: 1, startLine: 1 },
    { page: 2, startLine: 4 },
    { page: 3, startLine: 8 },
  ];

  it("maps sections to pages by startLine", () => {
    const md = "# Abstract\n\nbody\n\n## 2 Method\n\nmore body\n\n## 3 Results\n";
    const sections = extractPaperSections(md, { pageIndex });
    expect(sections).toEqual([
      { line: 1, level: 1, title: "Abstract", page: 1 },
      { line: 5, level: 1, title: "2 Method", page: 2 },
      { line: 9, level: 1, title: "3 Results", page: 3 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Full pipeline shape (server compatibility)
// ---------------------------------------------------------------------------

describe("toc.json shape", () => {
  it("is a flat array with line/level/title and optional page", () => {
    const md = [
      "# 1 Introduction",
      "",
      "The problem is hard.",
      "",
      "## 1.1 Motivation",
      "",
      "text",
      "",
      "# 2 Method",
      "",
      "# References",
      "",
    ].join("\n");

    const sections = extractPaperSections(md, {
      pageIndex: [
        { page: 1, startLine: 1 },
        { page: 2, startLine: 9 },
      ],
    });

    expect(Array.isArray(sections)).toBe(true);
    for (const s of sections) {
      expect(typeof s.line).toBe("number");
      expect(typeof s.level).toBe("number");
      expect(typeof s.title).toBe("string");
    }
    expect(sections).toEqual([
      { line: 1, level: 1, title: "1 Introduction", page: 1 },
      { line: 5, level: 2, title: "1.1 Motivation", page: 1 },
      { line: 9, level: 1, title: "2 Method", page: 2 },
      { line: 11, level: 1, title: "References", page: 2 },
    ]);
  });
});
