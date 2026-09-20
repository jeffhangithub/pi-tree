import type { ClientPlugin, ContentPanelProps } from "@pi-tree/ui";
import { PdfPanel } from "./PdfPanel.js";

// ---------------------------------------------------------------------------
// Adapter — injects the PDF file URL factory into the pure panel component
// (same pattern as plugin-book's ContentPanel).
// ---------------------------------------------------------------------------

/** Range-capable same-origin file endpoint (implemented in routes.ts). */
const getPdfUrl = (sourceId: string) =>
  `/api/paper/sources/${encodeURIComponent(sourceId)}/file`;

function PaperContentPanel(props: ContentPanelProps) {
  return <PdfPanel {...props} getPdfUrl={getPdfUrl} />;
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

/** Paper plugin — contributes the embedded pdf.js content panel. */
export function paperPlugin(): ClientPlugin {
  return {
    sourceType: "paper",
    contentPanel: PaperContentPanel,
  };
}
