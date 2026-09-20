/**
 * Shared types for the paper PDF panel.
 *
 * This module deliberately has NO pdfjs-dist import: PdfPanel.tsx imports it
 * eagerly, while pdf.js itself only loads through React.lazy → PdfViewer.
 */

/** Outline (bookmark) entry resolved to a 1-based page number. */
export interface PdfOutlineItem {
  title: string;
  /** 1-based page number; 0 when the destination could not be resolved. */
  page: number;
  children: PdfOutlineItem[];
}

/**
 * Selection metadata produced by the panel's getSelectionMeta hook.
 * Mirrors the generic SelectionMeta shape of @pi-tree/ui's SelectionToolbar
 * (page/section/context) — the toolbar contract stays PDF-agnostic.
 */
export interface PdfSelectionMeta {
  page?: number;
  section?: string;
  context?: string;
}

/**
 * Unified anchor — "pdf" variant of the P5 anchor model
 * (docs/dev/DEV_PLAN.zh.md Phase 5). Node storage keeps
 * `{ kind: "pdf", page, quote, section }`; the chat side produces the
 * sibling `{ kind: "content", nodeId, quote }` variant.
 */
export interface PdfAnchor {
  kind: "pdf";
  /** 1-based page number. */
  page: number;
  /** The exact selected text. */
  quote: string;
  /** Section title containing the selection ("" when unknown). */
  section: string;
}

/** Imperative API exposed by PdfViewer to PdfPanel. */
export interface PdfViewerHandle {
  scrollToPage: (page: number) => void;
  getScale: () => number;
  /** Highlight `quote` on `page` (text-layer metric matching + overlay). */
  highlightQuote: (quote: string, page: number) => void;
  /** Remove the current highlight overlay. */
  clearHighlight: () => void;
}

/** Section from the server analysis files (toc.json + page-index.json),
 *  used to cross-validate / fall back when the PDF has no outline. */
export interface ServerSection {
  title: string;
  level: number;
  page: number;
}

/** Flatten a nested outline into a depth-annotated list (TOC rendering). */
export interface FlatOutlineItem {
  title: string;
  page: number;
  depth: number;
}

export function flattenOutline(
  items: PdfOutlineItem[],
  depth = 0,
): FlatOutlineItem[] {
  const out: FlatOutlineItem[] = [];
  for (const item of items) {
    out.push({ title: item.title, page: item.page, depth });
    out.push(...flattenOutline(item.children, depth + 1));
  }
  return out;
}
