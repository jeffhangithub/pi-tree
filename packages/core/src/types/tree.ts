/**
 * Core tree and session types for pi-tree.
 *
 * These types define the tree-structured conversation model.
 * They are independent of any database or app-specific concepts.
 */

// ---------------------------------------------------------------------------
// Tree Node View — client-facing tree structure
// ---------------------------------------------------------------------------

export interface TreeNodeView {
  id: string;
  parentId: string | null;
  label: string;
  status: "active" | "completed" | "abandoned" | "placeholder";
  messageCount: number;
  summary?: string;
  children: TreeNodeView[];
  /** Whether this is the currently active node */
  isCurrent: boolean;
  /** Unified anchor attached to this (question) node, when present. */
  anchor?: UnifiedAnchor;
}

// ---------------------------------------------------------------------------
// Tool Step — intermediate tool call executed during an AI response
// ---------------------------------------------------------------------------

export interface ToolStep {
  toolName: string;
  args: Record<string, unknown>;
  status: "running" | "done" | "error";
}

// ---------------------------------------------------------------------------
// Chat Message — individual message in a conversation
// ---------------------------------------------------------------------------

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Timestamp ISO string */
  timestamp: string;
  /** If this message triggered a branch, the new node id */
  branchedToNodeId?: string;
  /** Tool calls executed by the AI to produce this response */
  toolSteps?: ToolStep[];
}

// ---------------------------------------------------------------------------
// Branch & Breadcrumb — navigation types
// ---------------------------------------------------------------------------

export interface BranchOption {
  nodeId: string;
  label: string;
  messageCount: number;
  status: "active" | "completed" | "abandoned" | "placeholder";
}

export interface BreadcrumbItem {
  nodeId: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Content Anchor — linking tree nodes to source content
// ---------------------------------------------------------------------------

export interface ContentAnchor {
  /** Line range in the markdown file (from the outline's navigation map) */
  lineRange: [start: number, end: number];
  /** The heading text from the outline */
  outlineHeading?: string;
}

// ---------------------------------------------------------------------------
// Unified Anchor — the P5 dual-anchor model (docs/dev/DEV_PLAN.zh.md Phase 5).
// Every question node can carry ONE anchor:
//   - pdf:     a text selection in the source PDF  { page, quote, section }
//   - content: a text selection in an AI answer   { nodeId, quote }
// Stored as a Pi SDK custom entry (session JSONL), exposed on TreeNodeView,
// and exported through the portable reading record.
// ---------------------------------------------------------------------------

/** Source-text anchor: a selection inside the rendered PDF. */
export interface PdfNodeAnchor {
  kind: "pdf";
  /** 1-based PDF page number. */
  page: number;
  /** The exact selected source text. */
  quote: string;
  /** Section title containing the selection ("" when unknown). */
  section: string;
}

/** Conversation-content anchor: a selection inside an AI answer. */
export interface ContentNodeAnchor {
  kind: "content";
  /** Entry id of the answer message that contained the selection. */
  nodeId: string;
  /** The exact selected answer fragment. */
  quote: string;
}

export type UnifiedAnchor = PdfNodeAnchor | ContentNodeAnchor;

// ---------------------------------------------------------------------------
// Session State — full state snapshot for a reading session
// ---------------------------------------------------------------------------

export interface SessionState {
  /** Database session ID — identifies which session within user+source */
  sessionId: number;
  userId: string;
  sourceId: string;
  activeNodeId: string;
  /** Which tree node the chat view is scoped to (null = root) */
  viewNodeId: string | null;
  breadcrumb: BreadcrumbItem[];
  /** Messages in the current scope (linear chain from viewNode to next fork) */
  messages: ChatMessage[];
  tree: TreeNodeView;
  /** Branches available at the end of the current chain (fork indicator) */
  branches: BranchOption[];
  /** Ancestor messages from root to the current scope (for 'Show full path' toggle) */
  parentContext?: ChatMessage[];
}
