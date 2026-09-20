// ---------------------------------------------------------------------------
// arXiv content acquisition for the processing pipeline.
//
// Deliberately separate from the chat-facing `readPaper` tool: the pipeline
// must persist the FULL paper text, so none of these helpers truncate
// (readPaper caps at 120k chars to protect chat context — never reuse it here).
// ---------------------------------------------------------------------------

import { writeFile } from "node:fs/promises";
import { normalizeArxivId, html2text } from "./arxiv.js";

const USER_AGENT = "pi-tree/1.0";
const AR5IV_BASE = "https://ar5iv.labs.arxiv.org/html";
const RETRY_DELAY_MS = 1000;

/**
 * Download the official arXiv PDF for an ID into destPath.
 * Retries a couple of times (arXiv rate-limits) and sanity-checks the payload.
 */
export async function downloadArxivPdf(
  arxivId: string,
  destPath: string,
  attempts = 3,
): Promise<void> {
  const id = normalizeArxivId(arxivId);
  const url = `https://arxiv.org/pdf/${id}`;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (!res.ok) throw new Error(`arXiv PDF returned ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      // Cheap sanity check — arXiv sometimes serves an error page as HTML.
      if (!buffer.subarray(0, 1024).includes("%PDF-")) {
        throw new Error("Downloaded payload is not a PDF (arXiv may have rejected the request)");
      }
      await writeFile(destPath, buffer);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Fetch the full ar5iv HTML rendering of a paper and convert it to markdown.
 * Reuses the existing html2text converter (h1-h6 → # headings); no truncation.
 */
export async function fetchAr5ivMarkdown(arxivId: string): Promise<string> {
  const id = normalizeArxivId(arxivId);
  const url = `${AR5IV_BASE}/${id}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`ar5iv returned ${res.status}`);
  const html = await res.text();
  return html2text(html);
}
