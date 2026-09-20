/**
 * Message and custom entry types for Pi session integration.
 */

import type { ContentAnchor, UnifiedAnchor } from "./tree.js";

// ---------------------------------------------------------------------------
// Custom entry types stored in Pi session
// ---------------------------------------------------------------------------

export interface TopicMeta {
  kind: "topic_node";
  label: string;
  source: "outline" | "user" | "auto" | "fork";
  contentAnchor?: ContentAnchor;
  status: "active" | "completed" | "abandoned" | "placeholder";
}

export interface SectionStatusMeta {
  kind: "section_status";
  targetEntryId: string;
  newStatus: "active" | "completed" | "abandoned";
}

export interface SectionLabelMeta {
  kind: "section_label";
  targetEntryId: string;
  newLabel: string;
}

/**
 * Unified anchor custom entry — attaches a P5 dual anchor (pdf | content)
 * to an existing tree entry (the question's user-message node). Append-only,
 * like section_status/section_label: stored in the session JSONL, survives
 * restarts, and rides along in the JSONL export bundle.
 */
export interface AnchorMeta {
  kind: "anchor";
  targetEntryId: string;
  anchor: UnifiedAnchor;
}

export type PiTreeData = TopicMeta | SectionStatusMeta | SectionLabelMeta | AnchorMeta;

// ---------------------------------------------------------------------------
// Annotated tree node (Pi tree + our metadata)
// ---------------------------------------------------------------------------

export interface AnnotatedTreeNode {
  entryId: string;
  parentId: string;
  label: string;
  source: "outline" | "user" | "auto" | "fork";
  status: "active" | "completed" | "abandoned" | "placeholder";
  contentAnchor?: ContentAnchor;
  /** Unified anchor (P5) attached to this node, when present. */
  anchor?: UnifiedAnchor;
  messageCount: number;
  isCurrent: boolean;
  summary?: string;
  children: AnnotatedTreeNode[];
}
