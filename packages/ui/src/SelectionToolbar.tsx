import { useCallback, useEffect, useRef, useState } from "react";
import { BookA, GitBranch, Pin, Quote } from "lucide-react";
import "./SelectionToolbar.css";

/** Extra metadata about a selection — generic, not PDF-specific. */
export interface SelectionMeta {
  /** 1-based page number when the selection lives in a paged document */
  page?: number;
  /** Section/chapter title containing the selection */
  section?: string;
  /** Overrides the default ±100-char context window (custom DOM without p/li) */
  context?: string;
}

export interface SelectionToolbarProps {
  /** Define: sends term + surrounding context to right sidebar dictionary panel */
  onDefine: (text: string, context?: string, meta?: SelectionMeta) => void;
  /** Ask: prefills chat input */
  onAsk?: (text: string, meta?: SelectionMeta) => void;
  /** Branch: quotes text and starts a new branch */
  onBranch?: (text: string, meta?: SelectionMeta) => void;
  /** Save: saves selected text as a memo */
  onSave?: (text: string, context?: string, meta?: SelectionMeta) => void;
  /** Container element to listen for selections in */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Custom DOM (e.g. a PDF text layer): derive page/section/context from
   *  the Range. Return undefined to fall back to the default context logic. */
  getSelectionMeta?: (
    range: Range,
    text: string,
    container: HTMLElement,
  ) => SelectionMeta | undefined;
}

interface ToolbarPosition {
  top: number;
  left: number;
}

export function SelectionToolbar({
  onDefine,
  onAsk,
  onBranch,
  onSave,
  containerRef,
  getSelectionMeta,
}: SelectionToolbarProps) {
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [meta, setMeta] = useState<SelectionMeta | undefined>(undefined);
  const [position, setPosition] = useState<ToolbarPosition | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  const dismiss = useCallback(() => {
    setSelectedText(null);
    setMeta(undefined);
    setPosition(null);
  }, []);

  /** Shared logic: read selection, position toolbar */
  const showToolbarForSelection = useCallback(() => {
    const selection = window.getSelection();
    const text = selection?.toString().trim();

    if (!text || text.length < 2 || text.length > 200) {
      return;
    }

    const range = selection?.getRangeAt(0);
    if (!range) return;

    const container = containerRef.current;
    if (!container || !container.contains(range.commonAncestorContainer)) {
      return;
    }

    setMeta(getSelectionMeta?.(range, text, container));

    const rect = range.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const scrollTop = container.scrollTop;

    setSelectedText(text);
    setPosition({
      top: rect.top - containerRect.top + scrollTop - 44,
      left: Math.min(
        Math.max(rect.left - containerRect.left + rect.width / 2, 80),
        containerRect.width - 80,
      ),
    });
  }, [containerRef, getSelectionMeta]);

  // Desktop: mouseup handler
  const handleMouseUp = useCallback(() => {
    requestAnimationFrame(() => {
      showToolbarForSelection();
    });
  }, [showToolbarForSelection]);

  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        dismiss();
      }
    },
    [dismiss],
  );

  // Desktop listeners
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("mousedown", handleMouseDown);

    return () => {
      container.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [containerRef, handleMouseUp, handleMouseDown]);

  // Mobile: selectionchange fires after long-press text selection.
  // We debounce it to avoid triggering during active drag.
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const handleSelectionChange = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        const selection = window.getSelection();
        const text = selection?.toString().trim();
        if (!text || text.length < 2) {
          return;
        }
        showToolbarForSelection();
      }, 300);
    };

    document.addEventListener("selectionchange", handleSelectionChange);

    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [showToolbarForSelection]);

  // Dismiss on scroll
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !selectedText) return;

    container.addEventListener("scroll", dismiss);
    return () => container.removeEventListener("scroll", dismiss);
  }, [containerRef, selectedText, dismiss]);

  // Dismiss on touch outside toolbar (mobile equivalent of mousedown)
  useEffect(() => {
    if (!selectedText) return;

    const handleTouchStart = (e: TouchEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        dismiss();
      }
    };

    document.addEventListener("touchstart", handleTouchStart, { passive: true });
    return () => document.removeEventListener("touchstart", handleTouchStart);
  }, [selectedText, dismiss]);

  if (!selectedText || !position) return null;

  /** Default context: ±100 chars around the selection in the nearest
   *  block-level container (.pit-chat-content / p / blockquote / li). */
  const extractContext = (range: Range, text: string): string | undefined => {
    const container =
      range.commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? range.commonAncestorContainer.parentElement
        : (range.commonAncestorContainer as HTMLElement);
    const blockParent = container?.closest(".pit-chat-content, p, blockquote, li");
    if (!blockParent) return undefined;
    const fullText = blockParent.textContent ?? "";
    const idx = fullText.indexOf(text);
    if (idx >= 0) {
      const start = Math.max(0, idx - 100);
      const end = Math.min(fullText.length, idx + text.length + 100);
      return fullText.slice(start, end).trim();
    }
    // Fallback: first 200 chars of the container
    return fullText.slice(0, 200).trim();
  };

  const handleDefine = () => {
    // Custom context (PDF page window) wins over the default DOM extraction.
    const selection = window.getSelection();
    let context = meta?.context;
    if (!context && selection && selection.rangeCount > 0) {
      context = extractContext(selection.getRangeAt(0), selectedText ?? "");
    }
    onDefine(selectedText!, context, meta);
    window.getSelection()?.removeAllRanges();
    dismiss();
  };

  const handleAsk = () => {
    if (onAsk) {
      onAsk(selectedText!, meta);
    }
    window.getSelection()?.removeAllRanges();
    dismiss();
  };

  const handleBranch = () => {
    if (onBranch) {
      onBranch(selectedText!, meta);
    }
    window.getSelection()?.removeAllRanges();
    dismiss();
  };

  const handleSave = () => {
    const selection = window.getSelection();
    let context = meta?.context;
    if (!context && selection && selection.rangeCount > 0) {
      context = extractContext(selection.getRangeAt(0), selectedText ?? "");
    }
    onSave!(selectedText!, context, meta);
    window.getSelection()?.removeAllRanges();
    dismiss();
  };

  return (
    <div
      ref={toolbarRef}
      className="pit-selection-toolbar"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
      }}
    >
      <div className="pit-selection-toolbar-buttons">
        {onAsk && (
          <button className="pit-selection-btn" onClick={handleAsk} title="Quote in chat">
            <Quote size={14} /> Quote
          </button>
        )}
        {onBranch && (
          <button className="pit-selection-btn" onClick={handleBranch} title="Quote and start a new branch">
            <GitBranch size={14} /> Branch
          </button>
        )}
        <button className="pit-selection-btn" onClick={handleDefine} title="Look up in dictionary">
          <BookA size={14} /> Define
        </button>
        {onSave && (
          <button className="pit-selection-btn" onClick={handleSave} title="Save as memo">
            <Pin size={14} /> Save
          </button>
        )}
      </div>
    </div>
  );
}
