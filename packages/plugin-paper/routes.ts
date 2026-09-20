import { Hono } from "hono";
import { join } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import type { PluginRouteContext, PluginSetupResult } from "@pi-tree/plugin-sdk";
import { PaperDiscoverProvider } from "./discover.js";
import { processPaper } from "./services/process-paper.js";

/**
 * sourceIds are slugified by the server upload/create routes; whitelist their
 * shape here so the file route can never escape the sources directory.
 */
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,100}$/;

/**
 * The paper plugin setup: registers the DiscoverProvider (as before) plus the
 * "paper" job-queue processor and the Range-aware PDF file route.
 */
export function setup(ctx: PluginRouteContext): PluginSetupResult {
  ctx.discover.registerProvider(new PaperDiscoverProvider());

  const sourcesBasePath = join(ctx.dataPath, "sources");

  // -------------------------------------------------------------------------
  // Processor — runs Phase 1 (deterministic) for uploaded PDFs and arXiv
  // sources. Concept extraction (Phase 3) is handled generically by the job
  // queue for `concepts: true` types.
  // -------------------------------------------------------------------------
  ctx.jobQueue.registerProcessor("paper", async (sourceId, onProgress, options) => {
    const sourceDir = join(sourcesBasePath, sourceId);

    // Force mode: clear cached analysis outputs so structuring re-runs.
    // Stored PDFs (paper.pdf / original.pdf) are never touched (spec §5).
    if (options?.force) {
      for (const file of ["toc.json", "page-index.json", "summary.md"]) {
        const filePath = join(sourceDir, "analysis", file);
        if (existsSync(filePath)) {
          try { unlinkSync(filePath); } catch { /* ignore */ }
        }
      }
    }

    // Phase 1: PDF / ar5iv → markdown/paper.md + toc.json (+ page-index.json).
    // The queue caps plugin progress at 85 to leave room for post-processing.
    await processPaper(sourceId, {
      sourcesBasePath,
      sources: ctx.sources,
      onProgress,
    });

    // Phase 2 (agentic outline/summary) is intentionally skipped for papers:
    // toc.json is produced deterministically above and the paper's abstract
    // serves as the summary. Kept as a documented, non-implemented option.
  });

  // -------------------------------------------------------------------------
  // File service — GET /api/paper/sources/:sourceId/file
  //   ?download=1 → attachment (full body)
  //   otherwise   → inline stream with full Range/206 support via serveStatic
  // -------------------------------------------------------------------------
  const routes = new Hono();

  routes.get("/sources/:sourceId/file", async (c) => {
    const sourceId = c.req.param("sourceId");

    // Security: strict sourceId whitelist + DB existence/type check before
    // any path is touched (defense against directory traversal).
    if (!SOURCE_ID_RE.test(sourceId)) {
      return c.json({ error: "Invalid source id" }, 400);
    }
    const row = await ctx.sources.get(sourceId);
    if (!row || row.type !== "paper") {
      return c.json({ error: "Source not found" }, 404);
    }

    // Canonical file: arXiv downloads live at paper.pdf; uploads keep the
    // server-written original.pdf (never deleted by the pipeline).
    const rel = [join(sourceId, "paper.pdf"), join(sourceId, "original.pdf")].find(
      (p) => existsSync(join(sourcesBasePath, p)),
    );
    if (!rel) {
      return c.json({ error: "File not found" }, 404);
    }

    if (c.req.query("download") === "1") {
      const { readFile } = await import("node:fs/promises");
      const data = await readFile(join(sourcesBasePath, rel));
      return c.body(data, 200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${sourceId}.pdf"`,
      });
    }

    // serveStatic handles HEAD/OPTIONS, Content-Type, Accept-Ranges and
    // Range/206 (createReadStream({start, end})). Its built-in traversal
    // check only inspects the REQUEST path, not the rewritten one — but rel
    // is built from the whitelisted sourceId plus a literal filename, so the
    // rewrite cannot escape sourcesBasePath.
    return serveStatic({
      root: sourcesBasePath,
      rewriteRequestPath: () => rel,
    })(c, async () => {});
  });

  return { routes, cleanup: () => {} };
}
