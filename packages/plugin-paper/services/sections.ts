// ---------------------------------------------------------------------------
// Paper section extraction — pure functions, unit-testable.
//
// Produces the flat toc.json shape consumed by the server's LibraryService:
//   [{ line, level, title, page? }]
// - `line`  — 1-based line number in markdown/paper.md (same convention as the
//             book pipeline; the AI `read` tool uses it as its offset).
// - `level` — heading depth (1/2/3 mostly).
// - `page`  — optional, 1-based PDF page number. Best-effort: present only for
//             PDF sources (from the PDF outline or the page index).
// ---------------------------------------------------------------------------

export interface PaperSection {
  line: number;
  level: number;
  title: string;
  /** 1-based PDF page number — best-effort, only for PDF sources. */
  page?: number;
}

export interface PageIndexEntry {
  /** 1-based PDF page number. */
  page: number;
  /** 1-based line in markdown/paper.md where this page's content starts. */
  startLine: number;
}

/** Mirrors pdf-parse's OutlineNode (title + dest + nested items). */
export interface OutlineItemLike {
  title: string;
  dest?: unknown;
  items?: OutlineItemLike[];
}

export interface ExtractSectionsOptions {
  /** PDF bookmarks — cross-check titles and map pages (best-effort). */
  outline?: OutlineItemLike[];
  /** Page → startLine mapping built while parsing a PDF. */
  pageIndex?: PageIndexEntry[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * (b) Well-known paper section names that appear as bare lines.
 * Only whole-line matches count, so body sentences never trigger these.
 */
const BARE_SECTION_NAMES = new Set([
  "abstract",
  "introduction",
  "related work",
  "background",
  "preliminaries",
  "method",
  "methodology",
  "approach",
  "model",
  "architecture",
  "experiment",
  "experiments",
  "evaluation",
  "results",
  "analysis",
  "discussion",
  "conclusion",
  "conclusions",
  "summary",
  "future work",
  "references",
  "bibliography",
  "acknowledgements",
  "acknowledgments",
  "appendix",
  "appendices",
]);

/**
 * (a) Numbered headings — the strongest signal in papers:
 *   "3.1 Introduction" / "3 Methodology" / "A.2 Proofs" / "IV Experiments"
 * Level = number of segments ("3" → 1, "3.1" → 2, "3.1.2" → 3).
 */
const NUMBERED_RE =
  /^(\d{1,3}|\b[A-Z]\b|IV|V|VI|VII|VIII|IX|X)(?:\.(\d{1,3}))?(?:\.(\d{1,3}))?\s+([A-Za-z][A-Za-z0-9 ,:–\-']{1,120})$/i;

const MD_HEADING_RE = /^(#{1,6})\s+(.+)$/;
const CODE_FENCE_RE = /^(`{3,}|~{3,})/;
const MAX_LINE_LENGTH = 150;

// ---------------------------------------------------------------------------
// Title helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Normalize a title for comparison — case/punctuation/markdown-insensitive. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_`#>]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip markdown artifacts (links, emphasis, anchors, HTML) from a title. */
export function cleanTitle(raw: string): string {
  return raw
    .replace(/\[\]\{#[^}]+\}/g, "")
    .replace(/\{[^}]+\}/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const SMALL_WORDS = new Set([
  "a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "of",
  "on", "or", "over", "the", "to", "via", "vs", "with",
]);

/** Roman-numeral section heads ("II Background") must survive title-casing. */
const ROMAN_NUMERALS = new Set([
  "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x",
  "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii", "xviii", "xix", "xx",
]);

/**
 * ALL-CAPS headings are common on arXiv (e.g. "3 RELATED WORK").
 * Normalize them to title case; leave already mixed-case titles untouched.
 */
export function normalizeCase(title: string): string {
  const words = title.split(/(\s+)/);
  let firstWordSeen = false;
  return words
    .map((part) => {
      if (!/^[A-Za-z]+$/.test(part)) {
        return part;
      }
      if (part === part.toUpperCase()) {
        const lower = part.toLowerCase();
        if (ROMAN_NUMERALS.has(lower)) {
          firstWordSeen = true;
          return part;
        }
        const keepLower = firstWordSeen && SMALL_WORDS.has(lower);
        firstWordSeen = true;
        return keepLower ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
      }
      firstWordSeen = true;
      return part;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isBareSectionName(line: string): boolean {
  // Whole-line equality, tolerating trailing punctuation ("Evaluation:").
  const stripped = line.replace(/[\s:.\u2013\u2014-]+$/u, "");
  if (stripped.length === 0) return false;
  // Require heading-like casing ("Approach" / "APPROACH"): lowercase
  // fragments ("approach.") are usually wrapped sentence tails in PDF text.
  if (!/^[A-Z]/.test(stripped)) return false;
  return BARE_SECTION_NAMES.has(stripped.toLowerCase());
}

function isPlausibleNumberedTitle(title: string, head: string): boolean {
  // Real headings don't end with a period or comma (sentence false positives).
  if (/[.,]$/.test(title)) return false;
  // Single-letter heads: must be uppercase ("A"/"B" appendix style) and start
  // a capitalized title word — "I think that …" and "a TEE cannot be …" are
  // sentence fragments, "A Proof of Theorem 1" is an appendix heading.
  if (/^[A-Za-z]$/.test(head)) {
    if (head !== head.toUpperCase()) return false;
    if (!/^[A-Z]/.test(title)) return false;
  }
  return true;
}

/** pdf.js outline dests are 0-based page indices when the first element is numeric. */
function destPage(dest: unknown): number | undefined {
  if (Array.isArray(dest) && typeof dest[0] === "number" && Number.isInteger(dest[0])) {
    return dest[0] + 1;
  }
  return undefined;
}

function flattenOutline(
  items: OutlineItemLike[],
  depth = 0,
  out: OutlineItemLike[] = [],
): OutlineItemLike[] {
  if (depth > 16) return out;
  for (const item of items) {
    if (item && typeof item.title === "string" && item.title.trim().length > 0) {
      out.push(item);
    }
    if (Array.isArray(item?.items)) {
      flattenOutline(item.items, depth + 1, out);
    }
  }
  return out;
}

function lineToPage(line: number, pageIndex?: PageIndexEntry[]): number | undefined {
  if (!pageIndex || pageIndex.length === 0) return undefined;
  let page: number | undefined;
  for (const entry of pageIndex) {
    if (entry.startLine <= line) page = entry.page;
    else break;
  }
  return page;
}

/**
 * (c) PDF outline cross-check:
 * - exact normalized-title match → adopt the outline wording + dest page;
 * - fuzzy (containment) match → best-effort page number only.
 */
function applyOutline(sections: PaperSection[], outline?: OutlineItemLike[]): void {
  if (!outline || outline.length === 0) return;

  const flat = flattenOutline(outline);
  const byNorm = new Map<string, OutlineItemLike>();
  for (const item of flat) {
    const norm = normalizeTitle(item.title);
    if (norm && !byNorm.has(norm)) byNorm.set(norm, item);
  }

  for (const section of sections) {
    const norm = normalizeTitle(section.title);
    const exact = norm ? byNorm.get(norm) : undefined;
    if (exact) {
      // Outline titles are usually the cleanest wording — adopt it.
      const cleaned = normalizeCase(cleanTitle(exact.title));
      if (cleaned) section.title = cleaned;
      const page = destPage(exact.dest);
      if (page !== undefined) section.page = page;
      continue;
    }
    // Fuzzy: outline entry contained in the section title (or vice versa),
    // e.g. outline "Motivation" ↔ section "1.1 Motivation".
    for (const item of flat) {
      const itemNorm = normalizeTitle(item.title);
      if (itemNorm.length < 4 || itemNorm.length === norm.length) continue;
      if (norm.includes(itemNorm) || itemNorm.includes(norm)) {
        const page = destPage(item.dest);
        if (page !== undefined) {
          section.page = page;
          break;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Extract markdown headings only (h1-h6 → level = # count). */
export function extractHeadingsFromMarkdown(markdown: string): PaperSection[] {
  const lines = markdown.split("\n");
  const out: PaperSection[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    if (CODE_FENCE_RE.test(rawLine)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock || rawLine.length === 0 || rawLine.length > MAX_LINE_LENGTH) continue;

    const md = rawLine.match(MD_HEADING_RE);
    if (!md) continue;
    const title = cleanTitle(md[2]);
    if (!title || /^[\d\s.]+$/.test(title)) continue;
    out.push({ line: i + 1, level: Math.min(md[1].length, 6), title: normalizeCase(title) });
  }
  return out;
}

/**
 * Extract paper sections from markdown, merging three sources in priority order:
 *   (a) numbered heading regex  — level from the segment count
 *   (b) markdown headings       — level from the # count (ar5iv output)
 *   (c) bare well-known section names — forced level 1
 * then cross-checked against the PDF outline (title wording + page numbers)
 * and the page index (line → page fallback).
 */
export function extractPaperSections(
  markdown: string,
  options: ExtractSectionsOptions = {},
): PaperSection[] {
  const { outline, pageIndex } = options;
  const lines = markdown.split("\n");
  const sections: PaperSection[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    if (CODE_FENCE_RE.test(rawLine)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock || rawLine.length === 0 || rawLine.length > MAX_LINE_LENGTH) continue;

    // Strip a markdown heading prefix so numbered/named patterns also match
    // heading lines ("## 3.1 Introduction") — the # count is the fallback level.
    const md = rawLine.match(MD_HEADING_RE);
    const inner = md ? md[2] : rawLine;

    let candidate: { level: number; title: string } | null = null;

    // (a) Numbered headings — strongest signal; their segment count wins over
    // the markdown level ("#### A.2 Proofs" → level 2).
    const numbered = inner.match(NUMBERED_RE);
    if (numbered) {
      const head = numbered[1];
      const title = numbered[4];
      if (isPlausibleNumberedTitle(title, head)) {
        const segments = [head, numbered[2], numbered[3]].filter(Boolean).length;
        // Keep the numbering prefix in the title (server toc.json examples
        // and the book pipeline both include it). Normalize case only on the
        // prose part so roman numerals survive ("IV Experiments").
        const full = `${head}${numbered[2] ? `.${numbered[2]}` : ""}${numbered[3] ? `.${numbered[3]}` : ""} ${normalizeCase(cleanTitle(title))}`;
        candidate = { level: segments, title: cleanTitle(full) };
      }
    } else if (md) {
      // (b) Markdown headings — ar5iv HTML conversion produces these natively.
      const title = cleanTitle(md[2]);
      if (title && !/^[\d\s.]+$/.test(title)) {
        candidate = { level: Math.min(md[1].length, 6), title: normalizeCase(title) };
      }
    } else if (isBareSectionName(inner)) {
      // (c) Bare section names — always level 1.
      candidate = { level: 1, title: inner };
    }

    if (!candidate) continue;

    // Dedupe: the same heading within ±3 lines with an equal normalized title
    // (e.g. a heading followed by its plain-text repetition).
    const last = sections[sections.length - 1];
    if (
      last &&
      Math.abs(i + 1 - last.line) <= 3 &&
      normalizeTitle(last.title) === normalizeTitle(candidate.title)
    ) {
      continue;
    }

    sections.push({ line: i + 1, level: candidate.level, title: candidate.title });
  }

  // (d) PDF outline cross-check: wording + dest page numbers.
  applyOutline(sections, outline);

  // (e) Page fallback: map remaining sections to pages via the page index.
  for (const section of sections) {
    if (section.page === undefined) {
      const page = lineToPage(section.line, pageIndex);
      if (page !== undefined) section.page = page;
    }
  }

  return sections;
}
