/**
 * PdfPanel — paper content panel: TOC (PDF outline, cross-checked against
 * the server toc.json + page-index.json), the lazy PdfViewer, and the
 * selection → unified-anchor data flow.
 *
 * Selection flow (P4 → P5 hand-off):
 *   text-layer mouseup → SelectionToolbar (reused from @pi-tree/ui)
 *     → getSelectionMeta(range) → { page, section, context }   (generic meta)
 *     → panel callback builds the unified anchor
 *         { kind: "pdf", page, quote, section }
 *     → dispatched as a `pi-tree:pdf-anchor` CustomEvent for the host to
 *       attach to the created tree node (P5), and used to compose the
 *       Ask/Branch message sent via ContentPanelProps.onSendMessage.
 */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ContentPanelProps } from "@pi-tree/ui";
import { FileText, HelpCircle, ListTree, Loader2, RotateCcw } from "lucide-react";
import "./PdfPanel.css";
import {
  flattenOutline,
  type FlatOutlineItem,
  type PdfAnchor,
  type PdfOutlineItem,
  type PdfSelectionMeta,
  type PdfViewerHandle,
  type ServerSection,
} from "./types.js";

// pdfjs-dist only loads when this lazy chunk is first needed.
const PdfViewer = lazy(() => import("./PdfViewer.js"));

export interface PdfPanelProps extends ContentPanelProps {
  /** Factory-injected (book-panel pattern): PDF file URL for a source. */
  getPdfUrl: (sourceId: string) => string;
}

/** Shape of analysis/toc.json written by the paper pipeline. */
interface TocSectionLike {
  line: number;
  level: number;
  title: string;
  page?: number;
}

/** Shape of analysis/page-index.json written by the paper pipeline. */
interface PageIndexLike {
  page: number;
  startLine: number;
}

/** Cross-check fallback: map server toc.json sections to pages via
 *  page-index.json (used when the PDF has no embedded outline). */
async function fetchAnalysisSections(
  sourceId: string,
): Promise<ServerSection[]> {
  const [tocRes, pageIndexRes] = await Promise.all([
    fetch(`/api/library/sources/${sourceId}/analysis/toc.json`),
    fetch(`/api/library/sources/${sourceId}/analysis/page-index.json`),
  ]);
  if (!tocRes.ok || !pageIndexRes.ok) return [];
  const toc = (await tocRes.json()) as TocSectionLike[];
  const pageIndex = (await pageIndexRes.json()) as PageIndexLike[];
  if (!Array.isArray(toc)) return [];

  const pageForLine = (line: number): number => {
    if (!Array.isArray(pageIndex) || pageIndex.length === 0) return 0;
    let page = pageIndex[0].page;
    for (const entry of pageIndex) {
      if (entry.startLine <= line) page = entry.page;
      else break;
    }
    return page;
  };

  return toc
    .map((section) => ({
      title: section.title,
      level: section.level ?? 1,
      page: section.page ?? pageForLine(section.line),
    }))
    .filter((section) => section.page > 0);
}

export function PdfPanel({
  sourceId,
  onDefine,
  onSendMessage,
  getPdfUrl,
}: PdfPanelProps) {
  const viewerRef = useRef<PdfViewerHandle | null>(null);
  const [outline, setOutline] = useState<PdfOutlineItem[]>([]);
  const [outlineLoaded, setOutlineLoaded] = useState(false);
  const [serverSections, setServerSections] = useState<ServerSection[]>([]);
  const [tocOpen, setTocOpen] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageText, setPageText] = useState<Map<number, boolean>>(new Map());
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [userId, setUserId] = useState<string | null>(null);

  // ---- Reset per-source state -------------------------------------------
  useEffect(() => {
    setOutline([]);
    setOutlineLoaded(false);
    setServerSections([]);
    setCurrentPage(1);
    setPageText(new Map());
    setViewerError(null);
  }, [sourceId]);

  // ---- Best-effort user id for Save (memo). Hidden when unavailable —
  //  backlog: inject currentUserId through the plugin factory instead. -----
  useEffect(() => {
    let cancelled = false;
    fetch("/api/users")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { users?: { id: string }[] } | null) => {
        if (!cancelled && data?.users?.length) setUserId(data.users[0].id);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- TOC: PDF outline first; fall back to server sections ------------
  const handleOutline = useCallback((items: PdfOutlineItem[]) => {
    setOutline(items);
    setOutlineLoaded(true);
  }, []);

  useEffect(() => {
    if (!outlineLoaded || outline.length > 0) return;
    let cancelled = false;
    fetchAnalysisSections(sourceId)
      .then((sections) => {
        if (!cancelled) setServerSections(sections);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sourceId, outlineLoaded, outline]);

  // ---- Unified anchor ----------------------------------------------------
  const buildAnchor = useCallback(
    (text: string, meta?: PdfSelectionMeta): PdfAnchor | null => {
      if (!meta?.page) return null;
      return {
        kind: "pdf",
        page: meta.page,
        quote: text,
        section: meta.section ?? "",
      };
    },
    [],
  );

  /** P5 hand-off: let the host attach the anchor to the created node. */
  const emitAnchor = useCallback((anchor: PdfAnchor) => {
    window.dispatchEvent(new CustomEvent("pi-tree:pdf-anchor", { detail: anchor }));
  }, []);

  /** Compose the "引用 + 提问" message from a selection anchor. */
  const sendSelectionMessage = useCallback(
    (text: string, meta?: PdfSelectionMeta) => {
      const anchor = buildAnchor(text, meta);
      if (anchor) emitAnchor(anchor);
      const locParts: string[] = [];
      if (anchor?.page) locParts.push(`第 ${anchor.page} 页`);
      if (anchor?.section) locParts.push(anchor.section);
      const loc = locParts.length > 0 ? `（${locParts.join(" · ")}）` : "";
      onSendMessage?.(`「${text}」${loc}——请解释这段。`);
    },
    [buildAnchor, emitAnchor, onSendMessage],
  );

  // Ask: direct-send (host attaches the anchor to the created question node).
  // Branch: same message, but forced into a new tree branch via the extended
  // onSendMessage contract — the anchor rides along the same pending channel.
  const handleAsk = sendSelectionMessage;
  const handleBranch = useCallback(
    (text: string, meta?: PdfSelectionMeta) => {
      const anchor = buildAnchor(text, meta);
      if (anchor) emitAnchor(anchor);
      const locParts: string[] = [];
      if (anchor?.page) locParts.push(`第 ${anchor.page} 页`);
      if (anchor?.section) locParts.push(anchor.section);
      const loc = locParts.length > 0 ? `（${locParts.join(" · ")}）` : "";
      onSendMessage?.(`「${text}」${loc}——请解释这段。`, { forceBranch: true });
    },
    [buildAnchor, emitAnchor, onSendMessage],
  );

  const handleSave = useCallback(
    async (text: string, context?: string) => {
      if (!userId) return;
      const title =
        text.slice(0, 60).replace(/\n/g, " ") + (text.length > 60 ? "…" : "");
      try {
        await fetch(`/api/memos/${userId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title,
            content: context ? `> ${text}\n\n${context}` : text,
            sourceId,
            origin: "selection",
          }),
        });
        window.dispatchEvent(new Event("pi-tree:memos-changed"));
      } catch (err) {
        console.error("Failed to save memo:", err);
      }
    },
    [userId, sourceId],
  );

  // ---- Selection metadata (generic SelectionToolbar hook) ----------------
  const getSelectionMeta = useCallback(
    (range: Range, text: string): PdfSelectionMeta | undefined => {
      const nodeToEl = (node: Node): HTMLElement | null =>
        node.nodeType === Node.ELEMENT_NODE
          ? (node as HTMLElement)
          : node.parentElement;
      const pageEl = (nodeToEl(range.startContainer)?.closest(
        "[data-page-number]",
      ) ??
        nodeToEl(range.endContainer)?.closest(
          "[data-page-number]",
        )) as HTMLElement | null;
      if (!pageEl) return undefined;
      const page = Number(pageEl.dataset.pageNumber) || undefined;
      const section = pageEl.dataset.section || undefined;
      const full = pageEl.textContent ?? "";
      const idx = full.indexOf(text);
      const context =
        idx >= 0
          ? full
              .slice(Math.max(0, idx - 100), idx + text.length + 100)
              .trim()
          : full.slice(0, 200).trim();
      return { page, section, context };
    },
    [],
  );

  // ---- Viewer callbacks --------------------------------------------------
  const handlePageChange = useCallback((page: number) => setCurrentPage(page), []);

  const handlePageTextStatus = useCallback((page: number, hasText: boolean) => {
    setPageText((prev) => {
      const next = new Map(prev);
      next.set(page, hasText);
      return next;
    });
  }, []);

  const handleViewerError = useCallback((message: string) => {
    setViewerError(message);
  }, []);

  // ---- Current section (header display, TOC highlight) -------------------
  const currentSection = useMemo(() => {
    const flat = outline.length
      ? flattenOutline(outline).filter((item) => item.page > 0)
      : serverSections.map((section) => ({
          title: section.title,
          page: section.page,
          depth: Math.max(0, section.level - 1),
        }));
    const sorted = [...flat].sort((a, b) => a.page - b.page);
    let section = "";
    for (const entry of sorted) {
      if (entry.page <= currentPage) section = entry.title;
      else break;
    }
    return section;
  }, [outline, serverSections, currentPage]);

  const hasToc = outline.length > 0 || serverSections.length > 0;
  const scanned =
    currentPage !== null && pageText.get(currentPage) === false;

  const jumpToPage = useCallback((page: number) => {
    if (!page) return;
    viewerRef.current?.scrollToPage(page);
    setCurrentPage(page);
  }, []);

  // ---- P5 jump-back: listen for "pi-tree:pdf-jump" from the host (tree
  // node click with a pdf anchor) → jump to the page + highlight the quote.
  useEffect(() => {
    const onPdfJump = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { page?: number; quote?: string }
        | null
        | undefined;
      if (!detail || typeof detail.page !== "number" || detail.page < 1) return;
      jumpToPage(detail.page);
      if (detail.quote && detail.quote.trim()) {
        viewerRef.current?.highlightQuote(detail.quote, detail.page);
      } else {
        viewerRef.current?.clearHighlight();
      }
    };
    window.addEventListener("pi-tree:pdf-jump", onPdfJump);
    return () => window.removeEventListener("pi-tree:pdf-jump", onPdfJump);
  }, [jumpToPage]);

  const askSection = useCallback(
    (title: string) => {
      // AI-side reading runs on ar5iv HTML, so the prompt is keyed by the
      // section TITLE (stable on both sides) — never by PDF page numbers.
      onSendMessage?.(`请讲解章节「${title}」：`);
    },
    [onSendMessage],
  );

  return (
    <div className="pdf-panel">
      <div className="pdf-panel-header">
        {hasToc && (
          <button
            type="button"
            className={`pdf-panel-toc-toggle${tocOpen ? " is-open" : ""}`}
            onClick={() => setTocOpen((open) => !open)}
            title="显示/隐藏目录"
          >
            <ListTree size={14} />
            目录
          </button>
        )}
        <span className="pdf-panel-header-info" title={currentSection}>
          {currentSection || `第 ${currentPage} 页`}
        </span>
        {viewerError && (
          <button
            type="button"
            className="pdf-panel-retry"
            onClick={() => {
              setViewerError(null);
              setRetryKey((key) => key + 1);
            }}
            title="重新加载 PDF"
          >
            <RotateCcw size={13} />
            重试
          </button>
        )}
      </div>

      {tocOpen && hasToc && (
        <div className="pdf-panel-toc">
          {outline.length > 0 ? (
            <OutlineToc items={outline} onJump={jumpToPage} onAsk={askSection} />
          ) : (
            <ServerToc sections={serverSections} onJump={jumpToPage} onAsk={askSection} />
          )}
        </div>
      )}

      {scanned && (
        <div className="pdf-panel-banner">
          此页无可选择文本（扫描页），仍可浏览。
        </div>
      )}

      <Suspense
        fallback={
          <div className="pdf-panel-loading">
            <Loader2 size={20} className="pdf-panel-spinner" />
            正在加载 PDF 查看器…
          </div>
        }
      >
        <PdfViewer
          key={retryKey}
          ref={viewerRef}
          url={getPdfUrl(sourceId)}
          outline={outline}
          getSelectionMeta={getSelectionMeta}
          onDefine={onDefine}
          onAsk={handleAsk}
          onBranch={handleBranch}
          onSave={userId ? handleSave : undefined}
          onOutline={handleOutline}
          onError={handleViewerError}
          onPageChange={handlePageChange}
          onPageTextStatus={handlePageTextStatus}
        />
      </Suspense>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TOC views
// ---------------------------------------------------------------------------

function OutlineToc({
  items,
  onJump,
  onAsk,
}: {
  items: PdfOutlineItem[];
  onJump: (page: number) => void;
  onAsk: (title: string) => void;
}) {
  const flat = flattenOutline(items).filter((item) => item.page > 0);
  if (flat.length === 0) {
    return (
      <div className="pdf-toc-empty">
        <FileText size={14} />
        此 PDF 无可用目录
      </div>
    );
  }
  return (
    <div className="pdf-toc-list">
      {flat.map((item, index) => (
        <TocRow
          key={`${item.title}-${index}`}
          item={item}
          onJump={onJump}
          onAsk={onAsk}
        />
      ))}
    </div>
  );
}

function ServerToc({
  sections,
  onJump,
  onAsk,
}: {
  sections: ServerSection[];
  onJump: (page: number) => void;
  onAsk: (title: string) => void;
}) {
  return (
    <div className="pdf-toc-list">
      {sections.map((section, index) => (
        <TocRow
          key={`${section.title}-${index}`}
          item={{ title: section.title, page: section.page, depth: Math.max(0, section.level - 1) }}
          onJump={onJump}
          onAsk={onAsk}
        />
      ))}
    </div>
  );
}

function TocRow({
  item,
  onJump,
  onAsk,
}: {
  item: FlatOutlineItem;
  onJump: (page: number) => void;
  onAsk: (title: string) => void;
}) {
  return (
    <div
      className="pdf-toc-row"
      style={{ paddingLeft: 8 + item.depth * 12 }}
    >
      <button
        type="button"
        className="pdf-toc-item"
        onClick={() => onJump(item.page)}
        title={item.title}
      >
        {item.title}
      </button>
      <button
        type="button"
        className="pdf-toc-ask"
        title="就此节提问"
        onClick={() => onAsk(item.title)}
      >
        <HelpCircle size={12} />
      </button>
    </div>
  );
}
