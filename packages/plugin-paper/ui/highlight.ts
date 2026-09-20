/**
 * highlight.ts — pure text-layer highlight math for the PDF panel.
 *
 * The rendered TextLayer is a set of absolutely-positioned spans (usually
 * one per line fragment); a quote can span several of them. This module
 * groups spans into visual lines (by their top offset), joins each line's
 * whitespace-normalized text, and locates the quote across lines — then
 * returns one covering rectangle per affected visual line. No DOM access,
 * fully unit-testable.
 */

/** Metrics of one rendered text-layer span (positions relative to the page). */
export interface TextSpanMetrics {
  text: string;
  /** Vertical offset of the span, in px. */
  top: number;
  /** Horizontal offset of the span, in px. */
  left: number;
  width: number;
  height: number;
}

/** A rectangle covering part of the quote (one visual line). */
export interface HighlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Collapse whitespace runs to single spaces (matching tolerance). */
const norm = (s: string) => s.replace(/\s+/g, " ");
/** Normalized span text, trimmed for joining (spans carry padding spaces). */
const spanText = (s: TextSpanMetrics) => norm(s.text).trim();

/**
 * Compute overlay rectangles covering the first occurrence of `quote` in
 * the span sequence. Matching is whitespace-normalized and may flow across
 * spans and visual lines (user selections do); the result is one rectangle
 * per affected line, covering only the spans the quote overlaps. Returns []
 * when the quote is absent or empty.
 */
export function computeHighlightRects(
  spans: TextSpanMetrics[],
  quote: string,
): HighlightRect[] {
  const target = norm(quote);
  if (!target || spans.length === 0) return [];

  // Group spans into visual lines first (same rounded offsetTop).
  const lines: TextSpanMetrics[][] = [];
  for (const span of spans) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last[0].top - span.top) < 2) last.push(span);
    else lines.push([span]);
  }

  const lineTexts = lines.map((line) => line.map(spanText).join(" "));
  const joined = lineTexts.join(" ");
  const idx = joined.indexOf(target);
  if (idx < 0) return [];
  const end = idx + target.length;

  // For each line overlapping the match range, select only the spans the
  // quote covers (line texts are joined with single spaces).
  const selectedLines: TextSpanMetrics[][] = [];
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    const segStart = pos;
    const segEnd = pos + lineTexts[i].length;
    const from = Math.max(segStart, idx);
    const to = Math.min(segEnd, end);
    if (to > from) {
      const relFrom = from - segStart;
      const relTo = to - segStart;
      const selected: TextSpanMetrics[] = [];
      let linePos = 0;
      for (const span of lines[i]) {
        const sStart = linePos;
        const sEnd = linePos + spanText(span).length;
        if (sEnd > relFrom && sStart < relTo) selected.push(span);
        linePos = sEnd + 1;
      }
      if (selected.length > 0) selectedLines.push(selected);
    }
    pos = segEnd + 1;
    if (pos > end) break;
  }
  if (selectedLines.length === 0) return [];

  return selectedLines.map((line) => {
    const top = Math.min(...line.map((l) => l.top));
    const left = Math.min(...line.map((l) => l.left));
    const right = Math.max(...line.map((l) => l.left + l.width));
    const bottom = Math.max(...line.map((l) => l.top + l.height));
    return {
      top: top - 2,
      left,
      width: right - left,
      height: bottom - top + 4,
    };
  });
}
