/**
 * pdf.js v5 singleton bootstrap for the paper PDF panel.
 *
 * - Worker: imported via Vite `?url` so dev serves it and build emits it as a
 *   standalone asset; `GlobalWorkerOptions.workerSrc` must be assigned before
 *   any `getDocument()` call (module-level assignment below).
 * - TextLayer: v5 class-based API — `page.render()` no longer accepts a
 *   `textLayer` parameter. The class is exported from the MAIN entry
 *   ("pdfjs-dist" → build/pdf.mjs); web/pdf_viewer.mjs only re-exports the
 *   legacy `TextLayerBuilder`.
 * - Version consistency: both imports resolve to the SAME pdfjs-dist install
 *   (the plugin-paper dependency, "~5.7.284"), so worker and library always
 *   match.
 */
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PdfOutlineItem } from "./types.js";

export { TextLayer } from "pdfjs-dist";

// One-time worker setup — must precede any getDocument() call.
GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Static asset roots. The {cmaps, standard_fonts, wasm} directories are
 * copied to packages/client/public/pdfjs/ (served by Vite in dev and emitted
 * into dist/ on build). They are optional: CJK Type0 fonts lose glyphs
 * without cmaps and JPEG2000 images fail without the wasm modules.
 */
export const PDFJS_ASSETS = {
  cMapUrl: "/pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/pdfjs/standard_fonts/",
  wasmUrl: "/pdfjs/wasm/",
};

const docCache = new Map<string, Promise<PDFDocumentProxy>>();

/**
 * Load a PDF document. Single-instance cache per URL (StrictMode double
 * effects and source switches reuse the same underlying document); failures
 * evict the cache entry so a retry refetches.
 */
export function loadPdf(url: string): Promise<PDFDocumentProxy> {
  let pending = docCache.get(url);
  if (!pending) {
    pending = getDocument({ url, ...PDFJS_ASSETS }).promise;
    docCache.set(url, pending);
    pending.catch(() => docCache.delete(url));
  }
  return pending;
}

/** Structural subset of pdfjs' outline nodes (OutlineNode is a JSDoc
 *  typedef in the .d.ts, not an exported interface). */
interface RawOutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items?: RawOutlineNode[];
}

/** Resolve an outline destination ({name} string or [ref, ...] array) to a
 *  1-based page number; undefined when unresolvable. */
async function resolveDestPage(
  doc: PDFDocumentProxy,
  dest: RawOutlineNode["dest"],
): Promise<number | undefined> {
  if (dest == null) return undefined;
  try {
    // The .d.ts types getDestination(id: string) but the runtime accepts both
    // named destinations and explicit [ref, view, ...] arrays.
    const explicit = await doc.getDestination(dest as string);
    const pageRef = Array.isArray(explicit) ? explicit[0] : undefined;
    if (!pageRef) return undefined;
    const index = await doc.getPageIndex(pageRef);
    return index >= 0 ? index + 1 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Load the PDF's embedded bookmark outline as a page-resolved tree.
 * Returns [] for scanned PDFs / documents without bookmarks — callers then
 * fall back to the server toc.json + page-index.json cross-check.
 */
export async function loadOutline(doc: PDFDocumentProxy): Promise<PdfOutlineItem[]> {
  let raw: RawOutlineNode[] | null = null;
  try {
    raw = (await doc.getOutline()) as RawOutlineNode[] | null;
  } catch {
    raw = null;
  }
  if (!raw || raw.length === 0) return [];

  const convert = async (nodes: RawOutlineNode[]): Promise<PdfOutlineItem[]> => {
    const out: PdfOutlineItem[] = [];
    for (const node of nodes) {
      const children = node.items?.length ? await convert(node.items) : [];
      const own = await resolveDestPage(doc, node.dest);
      // Pageless branch parents inherit their first child's page so they
      // still render as navigable TOC rows.
      const page = own ?? children.find((c) => c.page > 0)?.page ?? 0;
      out.push({ title: node.title, page, children });
    }
    return out;
  };
  return convert(raw);
}
