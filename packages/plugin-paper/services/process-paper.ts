// ---------------------------------------------------------------------------
// Paper processing pipeline — Phase 1 (deterministic).
//
// Mirrors the book plugin's processBook contract:
//   - idempotent: skips if markdown/ already has a .md file;
//   - writes markdown/paper.md + analysis/toc.json (+ analysis/page-index.json
//     for PDF sources) and updates the DB row to `ready`.
//
// Inputs (detected per source):
//   - metadata.arxivId → arXiv pipeline: metadata via the Atom API, PDF from
//     arxiv.org/pdf/{id} (stored at {sourceDir}/paper.pdf), full text from the
//     PDF or, failing that, ar5iv HTML. Both unavailable → metadata-only
//     degradation (no job failure).
//   - original.* PDF     → uploaded-file pipeline: PDF → per-page markdown.
//
// Original PDFs are NEVER deleted or renamed — the server's upload route owns
// original.pdf and the file service serves paper.pdf → original.pdf.
// ---------------------------------------------------------------------------

import { readFile, readdir, writeFile, mkdir, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { PDFParse } from "pdf-parse";
import type { SourceService, SourceInfo } from "@pi-tree/plugin-sdk";
import { normalizeArxivId, getPaperInfo, type ArxivEntry } from "./arxiv.js";
import { downloadArxivPdf, fetchAr5ivMarkdown } from "./fetch-paper.js";
import {
  extractPaperSections,
  type PageIndexEntry,
  type OutlineItemLike,
} from "./sections.js";

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Find the uploaded original file (original.*) in a source directory. */
export async function findOriginalFile(
  sourceDir: string,
): Promise<{ path: string; ext: string } | null> {
  try {
    const entries = await readdir(sourceDir);
    for (const entry of entries) {
      if (entry.startsWith("original")) {
        const ext = extname(entry).toLowerCase();
        return { path: join(sourceDir, entry), ext };
      }
    }
  } catch {
    // directory might not exist
  }
  return null;
}

export interface ParsedPaper {
  markdown: string;
  pageIndex: PageIndexEntry[];
  outline?: OutlineItemLike[];
  metadata: { title?: string; author?: string };
}

/**
 * Parse a PDF into per-page markdown:
 * - inserts `<!-- page:N -->` markers (1-based) so line ↔ page mapping is
 *   recoverable by the P4 rendering panel;
 * - builds the page-index ([{ page, startLine }]);
 * - surfaces the PDF outline (bookmarks) and Info-dictionary metadata.
 */
export async function parsePdfToMarkdown(pdfPath: string): Promise<ParsedPaper> {
  const buffer = await readFile(pdfPath);
  const pdf = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const info = await pdf.getInfo();
    const textResult = await pdf.getText();

    const pages = textResult.pages ?? [];
    const lines: string[] = [];
    const pageIndex: PageIndexEntry[] = [];
    for (const page of pages) {
      // Line numbers must match the FINAL markdown exactly (toc.json lines
      // are read as offsets into paper.md), so build the file line by line.
      pageIndex.push({ page: page.num, startLine: lines.length + 1 });
      lines.push(`<!-- page:${page.num} -->`);
      const text = (page.text ?? "").replace(/\r\n/g, "\n").trim();
      if (text) {
        for (const line of text.split("\n")) lines.push(line);
        lines.push(""); // blank separator between pages
      }
    }

    return {
      markdown: lines.join("\n"),
      pageIndex,
      outline: (info.outline ?? undefined) as OutlineItemLike[] | undefined,
      metadata: {
        title: info.info?.Title ?? undefined,
        author: info.info?.Author ?? undefined,
      },
    };
  } finally {
    await pdf.destroy().catch(() => {});
  }
}

function yearOf(published: string): number | null {
  const y = parseInt(published.slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
}

/** Minimal markdown for the "both PDF and ar5iv failed" degradation path. */
function buildMetadataOnlyMarkdown(entry: ArxivEntry | null, row: SourceInfo): string {
  const title = entry?.title ?? row.title;
  const authors = entry && entry.authors.length > 0 ? entry.authors.join(", ") : row.author;
  const abstractText = entry?.summary ?? "";
  return [
    `# ${title}`,
    authors ? `*${authors}*` : null,
    "## Abstract",
    abstractText ||
      "_(Full text unavailable — both the arXiv PDF and the ar5iv HTML failed to download.)_",
  ]
    .filter((l): l is string => l !== null)
    .join("\n\n");
}

export interface ProcessPaperDeps {
  sourcesBasePath: string;
  sources: Pick<SourceService, "get" | "update">;
  onProgress?: (step: string, progress: number) => void;
}

export interface ProcessPaperResult {
  sourceId: string;
  title: string;
  author: string;
  year?: number;
  lines: number;
  sections: number;
  hasPdf: boolean;
  pageCount: number;
  source: "upload" | "arxiv";
  alreadyProcessed: boolean;
}

export async function processPaper(
  sourceId: string,
  deps: ProcessPaperDeps,
): Promise<ProcessPaperResult> {
  const { sourcesBasePath, sources, onProgress } = deps;

  // 1. Validate the source exists
  const row = await sources.get(sourceId);
  if (!row) {
    throw new Error(`Source '${sourceId}' not found in database.`);
  }

  const sourceDir = join(sourcesBasePath, sourceId);
  const markdownDir = join(sourceDir, "markdown");
  const analysisDir = join(sourceDir, "analysis");
  const paperMdPath = join(markdownDir, "paper.md");
  const paperPdfPath = join(sourceDir, "paper.pdf");

  // 2. Idempotency — same contract as book's processBook: any existing
  // markdown file means the source was already parsed.
  if (await exists(markdownDir)) {
    const files = await readdir(markdownDir);
    if (files.some((f) => f.endsWith(".md"))) {
      await sources.update(sourceId, { status: "ready", error: null });
      return {
        sourceId,
        title: row.title,
        author: row.author,
        year: row.year ?? undefined,
        lines: 0,
        sections: 0,
        hasPdf: (await exists(paperPdfPath)) || (await exists(join(sourceDir, "original.pdf"))),
        pageCount: 0,
        source: "upload",
        alreadyProcessed: true,
      };
    }
  }

  // 3. Identify the input: arXiv ID (metadata) or uploaded PDF
  const arxivIdRaw = typeof row.metadata?.arxivId === "string" ? row.metadata.arxivId.trim() : "";
  const arxivId = arxivIdRaw ? normalizeArxivId(arxivIdRaw) : null;

  let markdown: string;
  let pageIndex: PageIndexEntry[] = [];
  let outline: OutlineItemLike[] | undefined;
  let pdfMeta: { title?: string; author?: string } = {};
  let arxivEntry: ArxivEntry | null = null;
  let hasPdf = false;
  let kind: "upload" | "arxiv" = "upload";

  if (arxivId) {
    kind = "arxiv";
    onProgress?.("downloading", 10);

    // Sources created via /sources/create (arXiv metadata) have no directory
    // yet — the upload route normally creates it.
    await mkdir(sourceDir, { recursive: true });

    // arXiv metadata (title/authors/abstract/year). Failure is non-fatal —
    // the PDF/ar5iv download below and the stored DB fields still work.
    try {
      arxivEntry = await getPaperInfo(arxivId);
    } catch (err) {
      console.warn(
        `[paper] Metadata lookup failed for ${arxivId}, continuing with stored metadata:`,
        err,
      );
    }

    // The PDF is always archived at paper.pdf (file service + retention), but
    // the markdown prefers the ar5iv HTML rendering: its h1-h6 structure
    // yields a far better toc.json than raw PDF text extraction (spec §3).
    // PDF text extraction is the fallback when ar5iv is unavailable.
    try {
      await downloadArxivPdf(arxivId, paperPdfPath);
      hasPdf = true;
    } catch (err) {
      console.warn(`[paper] PDF download failed for ${arxivId}:`, err);
    }

    onProgress?.("converting", 30);
    let ar5iv: string | null = null;
    try {
      ar5iv = await fetchAr5ivMarkdown(arxivId);
    } catch (err) {
      console.warn(`[paper] ar5iv fetch failed for ${arxivId}:`, err);
    }

    if (ar5iv && ar5iv.trim()) {
      markdown = ar5iv;
    } else if (hasPdf) {
      const parsed = await parsePdfToMarkdown(paperPdfPath);
      markdown = parsed.markdown;
      pageIndex = parsed.pageIndex;
      outline = parsed.outline;
      pdfMeta = parsed.metadata;
    } else {
      // Graceful degradation: metadata-only source (spec §9 risk 1).
      markdown = buildMetadataOnlyMarkdown(arxivEntry, row);
    }
  } else {
    const original = await findOriginalFile(sourceDir);
    if (!original) {
      // Metadata-only paper (no arXiv ID, no uploaded PDF) — nothing to parse.
      console.warn(`[paper] No PDF or arXiv ID for ${sourceId}; keeping it metadata-only.`);
      await sources.update(sourceId, { status: "ready", error: null });
      return {
        sourceId,
        title: row.title,
        author: row.author,
        year: row.year ?? undefined,
        lines: 0,
        sections: 0,
        hasPdf: false,
        pageCount: 0,
        source: "upload",
        alreadyProcessed: false,
      };
    }
    if (original.ext !== ".pdf") {
      throw new Error(
        `Paper sources only support PDF uploads (found '${original.ext}'). ` +
          `Upload a PDF or provide an arXiv ID.`,
      );
    }
    onProgress?.("converting", 30);
    const parsed = await parsePdfToMarkdown(original.path);
    markdown = parsed.markdown;
    pageIndex = parsed.pageIndex;
    outline = parsed.outline;
    pdfMeta = parsed.metadata;
    hasPdf = true;
  }

  // 4. Write markdown/paper.md
  await mkdir(markdownDir, { recursive: true });
  await writeFile(paperMdPath, markdown, "utf-8");

  // 5. Extract sections → analysis/toc.json (+ page-index.json for PDFs)
  onProgress?.("structuring", 55);
  const sections = extractPaperSections(markdown, {
    outline: outline && outline.length > 0 ? outline : undefined,
    pageIndex: pageIndex.length > 0 ? pageIndex : undefined,
  });

  await mkdir(analysisDir, { recursive: true });
  await writeFile(
    join(analysisDir, "toc.json"),
    JSON.stringify(sections, null, 2),
    "utf-8",
  );
  if (pageIndex.length > 0) {
    await writeFile(
      join(analysisDir, "page-index.json"),
      JSON.stringify(pageIndex, null, 2),
      "utf-8",
    );
  }

  // 6. Update DB metadata — arXiv entry > PDF info > stored values (book order)
  const title = arxivEntry?.title ?? pdfMeta.title ?? row.title;
  const author =
    arxivEntry && arxivEntry.authors.length > 0
      ? arxivEntry.authors.join(", ")
      : pdfMeta.author ?? row.author;
  const year = arxivEntry
    ? yearOf(arxivEntry.published) ?? row.year ?? undefined
    : row.year ?? undefined;

  // Mark scanned PDFs (no text layer) so the P4 panel can degrade gracefully.
  const hasText = markdown.replace(/<!-- page:\d+ -->/g, "").trim().length > 0;
  const nextMetadata = hasText
    ? row.metadata
    : { ...(row.metadata ?? {}), scanned: true };

  await sources.update(sourceId, {
    status: "ready",
    error: null,
    title,
    author,
    ...(year !== undefined ? { year } : {}),
    ...(nextMetadata !== undefined ? { metadata: nextMetadata } : {}),
  });

  return {
    sourceId,
    title,
    author,
    year,
    lines: markdown.split("\n").length,
    sections: sections.length,
    hasPdf,
    pageCount: pageIndex.length,
    source: kind,
    alreadyProcessed: false,
  };
}
