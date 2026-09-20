/**
 * PdfViewer — the pdf.js renderer, loaded lazily (React.lazy) so pdfjs-dist
 * lands in its own chunk instead of the first-screen bundle.
 *
 * Rendering model:
 * - Continuous scroll: one wrapper div per page (sized up front from each
 *   page's scale-1 viewport, so scroll layout is stable before paint).
 * - On-demand paint: each page renders its canvas + TextLayer only when it
 *   approaches the viewport (IntersectionObserver), then stays rendered.
 * - Zoom: scale = fitWidth * zoom. The page wrapper carries a
 *   `--scale-factor` CSS variable; the v5 TextLayer sizes its spans from
 *   `--total-scale-factor` (derived from it), so canvas and text stay
 *   aligned. Both are torn down and re-rendered on every scale change.
 * - StrictMode safety: every render lives in an effect whose cleanup cancels
 *   the RenderTask and the TextLayer and resets the canvas.
 */
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { SelectionToolbar } from "@pi-tree/ui";
import type {
  PDFDocumentProxy,
  RenderTask,
  TextLayer as TextLayerType,
} from "pdfjs-dist";
import { loadOutline, loadPdf, TextLayer } from "./pdfjs.js";
import { computeHighlightRects, type TextSpanMetrics } from "./highlight.js";
import type {
  PdfOutlineItem,
  PdfSelectionMeta,
  PdfViewerHandle,
} from "./types.js";

interface PageInfo {
  pageNumber: number;
  width: number;
  height: number;
}

/** Adaptive initial zoom bounds: never below 60% (unreadable) and never above
 *  200% (a single page swallowing the whole panel — the old default was 205%). */
const FIT_SCALE_MIN = 0.6;
const FIT_SCALE_MAX = 2;

export interface PdfViewerProps {
  /** Same-origin PDF URL (Range-capable, e.g. /api/paper/sources/:id/file). */
  url: string;
  ref?: React.Ref<PdfViewerHandle>;
  /** Page-resolved outline — drives data-section per page. */
  outline?: PdfOutlineItem[];
  /** PDF-specific selection metadata (page/section/context). */
  getSelectionMeta?: (
    range: Range,
    text: string,
    container: HTMLElement,
  ) => PdfSelectionMeta | undefined;
  onDefine?: (text: string, context?: string) => void;
  onAsk?: (text: string, meta?: PdfSelectionMeta) => void;
  onBranch?: (text: string, meta?: PdfSelectionMeta) => void;
  onSave?: (text: string, context?: string) => void;
  onOutline?: (outline: PdfOutlineItem[]) => void;
  onError?: (message: string) => void;
  onPageChange?: (page: number) => void;
  onPageTextStatus?: (page: number, hasText: boolean) => void;
}

export default function PdfViewer({
  url,
  ref,
  outline,
  getSelectionMeta,
  onDefine,
  onAsk,
  onBranch,
  onSave,
  onOutline,
  onError,
  onPageChange,
  onPageTextStatus,
}: PdfViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [containerWidth, setContainerWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** P5 jump-back highlight request: {page, quote} to overlay on the text layer. */
  const [highlight, setHighlight] = useState<{ page: number; quote: string; nonce: number } | null>(null);

  // ---- Document lifecycle (StrictMode-safe: cancelled flag + cached doc) --
  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setPages([]);
    setLoadError(null);
    setCurrentPage(1);
    setHighlight(null); // stale highlight from a previous source must not linger

    loadPdf(url)
      .then(async (loaded) => {
        if (cancelled) return;
        setDoc(loaded);
        // Precompute every page's scale-1 size so wrappers get correct
        // dimensions (stable scroll layout) before anything is painted.
        const pageProxies = await Promise.all(
          Array.from({ length: loaded.numPages }, (_, i) => loaded.getPage(i + 1)),
        );
        const infos: PageInfo[] = pageProxies.map((page) => {
          const viewport = page.getViewport({ scale: 1 });
          return {
            pageNumber: page.pageNumber,
            width: viewport.width,
            height: viewport.height,
          };
        });
        if (cancelled) return;
        setPages(infos);
        onOutline?.(await loadOutline(loaded));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : "Failed to load PDF";
        setLoadError(message);
        onError?.(message);
      });

    return () => {
      cancelled = true;
    };
  }, [url, onOutline, onError]);

  // ---- Fit-width scale -----------------------------------------------
  // The content panel is narrow (400 px by default), so the *initial* zoom
  // must come from the real container width instead of a hard-coded 100%/205%
  // default. It follows the container on every resize (ResizeObserver), so
  // widening/narrowing the panel re-fits instead of jumping to 205%.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fitScale = useMemo(() => {
    const baseWidth = pages.reduce((max, p) => Math.max(max, p.width), 0);
    if (!baseWidth || containerWidth <= 0) return 1;
    // containerWidth includes the scroll container's 12px horizontal padding.
    const scale = (containerWidth - 32) / baseWidth;
    return Math.min(Math.max(scale, FIT_SCALE_MIN), FIT_SCALE_MAX);
  }, [pages, containerWidth]);

  const scale = fitScale * zoom;

  // ---- Section title per page (from outline, for data-section) ---------
  const sectionForPage = useMemo(() => {
    const flat = outline
      ?.flatMap((root) => walk(root))
      .sort((a, b) => a.page - b.page);
    return (page: number): string => {
      let section = "";
      for (const entry of flat ?? []) {
        if (entry.page > 0 && entry.page <= page) section = entry.title;
        else if (entry.page > page) break;
      }
      return section;
    };
  }, [outline]);

  // ---- Current page tracking (topmost page in the reading band) --------
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || pages.length === 0) return;
    const visible = new Map<number, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const n = Number((entry.target as HTMLElement).dataset.pageNumber);
          if (Number.isFinite(n)) visible.set(n, entry.isIntersecting);
        }
        const topmost = [...visible.entries()]
          .filter(([, isVisible]) => isVisible)
          .map(([n]) => n)
          .sort((a, b) => a - b)[0];
        if (topmost) setCurrentPage(topmost);
      },
      { rootMargin: "-10% 0px -75% 0px", threshold: 0 },
    );
    for (const [, el] of pageRefs.current) observer.observe(el);
    return () => observer.disconnect();
  }, [pages]);

  useEffect(() => {
    onPageChange?.(currentPage);
  }, [currentPage, onPageChange]);

  // ---- Imperative handle (TOC jumps) ----------------------------------
  useImperativeHandle(
    ref,
    () => ({
      scrollToPage(page: number) {
        const el = pageRefs.current.get(page);
        const scroller = scrollRef.current;
        if (!el || !scroller) return;
        scroller.scrollTo({ top: el.offsetTop - 8, behavior: "smooth" });
      },
      getScale() {
        return scale;
      },
      highlightQuote(quote: string, page: number) {
        if (!quote.trim() || !Number.isFinite(page) || page < 1) return;
        setHighlight({ page, quote, nonce: Date.now() });
      },
      clearHighlight() {
        setHighlight(null);
      },
    }),
    [scale],
  );

  const registerRef = useCallback((page: number, el: HTMLDivElement | null) => {
    if (el) pageRefs.current.set(page, el);
    else pageRefs.current.delete(page);
  }, []);

  const zoomIn = useCallback(
    () => setZoom((z) => Math.min(4, +(z * 1.25).toFixed(2))),
    [],
  );
  const zoomOut = useCallback(
    () => setZoom((z) => Math.max(0.5, +(z / 1.25).toFixed(2))),
    [],
  );
  const fitWidth = useCallback(() => setZoom(1), []);

  const ready = doc !== null && pages.length > 0;

  return (
    <div className="pdf-viewer">
      <div className="pdf-viewer-toolbar">
        <span className="pdf-viewer-page-indicator">
          {pages.length > 0 ? `${currentPage} / ${pages.length}` : "– / –"}
        </span>
        <span className="pdf-viewer-toolbar-actions">
          <button
            type="button"
            className="pdf-viewer-btn"
            onClick={fitWidth}
            title="适应宽度"
          >
            适配
          </button>
          <button
            type="button"
            className="pdf-viewer-btn"
            onClick={zoomOut}
            title="缩小"
          >
            −
          </button>
          <span className="pdf-viewer-zoom-label">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            className="pdf-viewer-btn"
            onClick={zoomIn}
            title="放大"
          >
            +
          </button>
        </span>
      </div>
      <div className="pdf-viewer-scroll" ref={scrollRef}>
        {loadError ? (
          <div className="pdf-viewer-error">加载 PDF 失败：{loadError}</div>
        ) : !ready ? (
          <div className="pdf-viewer-loading">正在加载 PDF…</div>
        ) : (
          pages.map((info) => (
            <PdfPage
              key={info.pageNumber}
              doc={doc}
              info={info}
              scale={scale}
              section={sectionForPage(info.pageNumber)}
              highlightQuote={highlight && highlight.page === info.pageNumber ? highlight.quote : null}
              registerRef={registerRef}
              onTextStatus={onPageTextStatus}
            />
          ))
        )}
        {ready && onDefine && (
          <SelectionToolbar
            containerRef={scrollRef}
            onDefine={onDefine}
            onAsk={onAsk}
            onBranch={onBranch}
            onSave={onSave}
            getSelectionMeta={getSelectionMeta}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single page — canvas + TextLayer with strict render-task lifecycle
// ---------------------------------------------------------------------------

interface PdfPageProps {
  doc: PDFDocumentProxy;
  info: PageInfo;
  scale: number;
  section: string;
  /** Quote to highlight on this page (P5 jump-back), or null. */
  highlightQuote: string | null;
  registerRef: (page: number, el: HTMLDivElement | null) => void;
  onTextStatus?: (page: number, hasText: boolean) => void;
}

function PdfPage({
  doc,
  info,
  scale,
  section,
  highlightQuote,
  registerRef,
  onTextStatus,
}: PdfPageProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const highlightOverlayRef = useRef<HTMLDivElement>(null);
  const [shouldRender, setShouldRender] = useState(false);
  const [renderFailed, setRenderFailed] = useState(false);

  const width = Math.max(1, Math.floor(info.width * scale));
  const height = Math.max(1, Math.floor(info.height * scale));

  /**
   * Overlay the current highlight quote on the rendered text layer.
   * Metrics come from the absolutely-positioned text-layer spans (offsets
   * are relative to the page wrapper), so canvas and overlay stay aligned.
   */
  const applyHighlightOverlay = useCallback(() => {
    const container = highlightOverlayRef.current;
    const layer = textLayerRef.current;
    if (!container || !layer) return;
    container.replaceChildren();

    const quote = highlightQuoteRef.current;
    if (!quote || !quote.trim()) return;

    const spans = Array.from(layer.querySelectorAll("span")).filter(
      (s) => (s.textContent ?? "").trim().length > 0,
    ) as HTMLElement[];
    if (spans.length === 0) return;

    const metrics: TextSpanMetrics[] = spans.map((s) => ({
      text: s.textContent ?? "",
      top: s.offsetTop,
      left: s.offsetLeft,
      width: s.offsetWidth,
      height: s.offsetHeight,
    }));

    for (const rect of computeHighlightRects(metrics, quote)) {
      const div = document.createElement("div");
      div.className = "pdf-page-highlight";
      div.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;`;
      container.appendChild(div);
    }
  }, []);

  // Latest highlight request, readable from the render effect without
  // re-triggering a full page re-render on every highlight change.
  const highlightQuoteRef = useRef<string | null>(highlightQuote);
  useEffect(() => {
    highlightQuoteRef.current = highlightQuote;
    applyHighlightOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightQuote, applyHighlightOverlay]);

  // Register for parent TOC scrollToPage.
  useEffect(() => {
    registerRef(info.pageNumber, wrapperRef.current);
    return () => registerRef(info.pageNumber, null);
  }, [info.pageNumber, registerRef]);

  // On-demand paint: render once the page approaches the viewport.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setShouldRender(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldRender(true);
          observer.disconnect();
        }
      },
      { rootMargin: "400px 0px 400px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Canvas + text layer. Cleanup cancels both tasks and resets the canvas,
  // which keeps React 19 StrictMode double-effects and zoom re-renders safe.
  useEffect(() => {
    if (!shouldRender) return;
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let textLayer: TextLayerType | null = null;

    const wrapper = wrapperRef.current;
    const canvas = canvasRef.current;
    const textLayerDiv = textLayerRef.current;
    if (!wrapper || !canvas || !textLayerDiv) return;

    // pdf.js v5 positions text-layer spans as a % of the layer and sizes the
    // glyphs with `calc(var(--text-scale-factor) * var(--font-height))`, where
    // --text-scale-factor = --total-scale-factor * --min-font-size (see
    // PdfPanel.css). Set it DIRECTLY to the active scale on the page wrapper:
    // the pdf.js `.pdfViewer .page` rule that computes it from --user-unit
    // never applies to our markup, and an unresolved value leaves the spans at
    // the app's inherited font-size (overlapping text, garbled selection).
    wrapper.style.setProperty("--total-scale-factor", String(scale));
    wrapper.style.setProperty("--scale-factor", String(scale));

    (async () => {
      try {
        const page = await doc.getPage(info.pageNumber);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        // Render at the display's device pixel ratio so text stays crisp on
        // HiDPI screens; the CSS box stays at viewport size in CSS pixels.
        const outputScale = Math.max(1, window.devicePixelRatio || 1);
        canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
        canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
        canvas.style.width = `${Math.max(1, Math.floor(viewport.width))}px`;
        canvas.style.height = `${Math.max(1, Math.floor(viewport.height))}px`;
        // v5: pass the canvas element (canvasContext is legacy/optional).
        renderTask = page.render({
          canvas,
          viewport,
          ...(outputScale !== 1
            ? { transform: [outputScale, 0, 0, outputScale, 0, 0] }
            : {}),
        });
        textLayer = new TextLayer({
          textContentSource: page.streamTextContent(),
          container: textLayerDiv,
          viewport,
        });
        await Promise.all([renderTask.promise, textLayer.render()]);
        if (cancelled) return;
        setRenderFailed(false);
        applyHighlightOverlay();
        const hasText =
          textLayer.textContentItemsStr.join("").trim().length > 0;
        onTextStatus?.(info.pageNumber, hasText);
      } catch (err) {
        if (cancelled) return; // RenderingCancelledException on cleanup
        renderTask?.cancel();
        textLayer?.cancel();
        console.error(`Failed to render page ${info.pageNumber}`, err);
        setRenderFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      textLayerDiv.replaceChildren();
      highlightOverlayRef.current?.replaceChildren();
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [doc, info.pageNumber, scale, shouldRender, onTextStatus, applyHighlightOverlay]);

  return (
    <div
      ref={wrapperRef}
      className="pdf-page"
      data-page-number={info.pageNumber}
      data-section={section}
      style={{ width, height }}
    >
      <canvas ref={canvasRef} className="pdf-page-canvas" />
      <div ref={textLayerRef} className="pdf-page-text-layer textLayer" />
      <div ref={highlightOverlayRef} className="pdf-page-highlights" />
      {renderFailed && (
        <div className="pdf-page-render-error">此页渲染失败</div>
      )}
    </div>
  );
}

/** Depth-first flatten of an outline tree into {title, page} entries. */
function walk(item: PdfOutlineItem): { title: string; page: number }[] {
  return [
    { title: item.title, page: item.page },
    ...item.children.flatMap((child) => walk(child)),
  ];
}
