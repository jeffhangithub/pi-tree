/**
 * reading-record.ts — portable reading record (P5, docs/dev/DEV_PLAN.zh.md).
 *
 * Flattens a conversation tree into a plain JSON document shared by pi-tree
 * and (later) the Zotero plugin:
 *
 *   { "source": "…", "nodes": [ { id, parentId, question, answer, anchor } ] }
 *
 * Mapping rules (bidirectionally reversible with the tree):
 * - One record row per user-message node (the "question" node).
 * - parentId = the nearest ancestor question node (null for the first).
 * - question = the node's message content.
 * - answer   = the first assistant-message content among the node's children
 *              ("" when the question has no direct answer, e.g. a fork).
 * - anchor   = the node's unified anchor, or null.
 *
 * Pure function over TreeNodeView + content map — no Pi SDK or DB access.
 */

import type { TreeNodeView, UnifiedAnchor } from "../types/index.js";

export interface MessageContentLike {
  role: string;
  content: string;
}

export interface ReadingRecordNode {
  id: string;
  parentId: string | null;
  question: string;
  answer: string;
  anchor: UnifiedAnchor | null;
}

export interface ReadingRecord {
  /** Human-readable source name (e.g. the paper title). */
  source: string;
  nodes: ReadingRecordNode[];
}

type ContentMap = Record<string, MessageContentLike>;
type AnchorMap = ReadonlyMap<string, UnifiedAnchor> | Record<string, UnifiedAnchor>;

function getAnchor(anchors: AnchorMap, id: string): UnifiedAnchor | null {
  if (anchors instanceof Map) return anchors.get(id) ?? null;
  return (anchors as Record<string, UnifiedAnchor>)[id] ?? null;
}

/**
 * Build the flat reading record from a (placeholder-stripped) tree view.
 */
export function buildReadingRecord(
  tree: TreeNodeView,
  contents: ContentMap,
  anchors: AnchorMap,
  source: string,
): ReadingRecord {
  const nodes: ReadingRecordNode[] = [];

  const walk = (node: TreeNodeView, parentId: string | null): void => {
    const own = contents[node.id];
    let emittedId: string | null = parentId;

    if (own && own.role === "user" && own.content.trim() !== "") {
      const answer =
        (node.children ?? [])
          .map((child) => contents[child.id])
          .find(
            (c): c is MessageContentLike =>
              !!c && c.role === "assistant" && c.content.trim() !== "",
          )?.content ?? "";

      nodes.push({
        id: node.id,
        parentId,
        question: own.content,
        answer,
        anchor: getAnchor(anchors, node.id),
      });
      emittedId = node.id;
    }

    for (const child of node.children ?? []) {
      walk(child, emittedId);
    }
  };

  walk(tree, null);
  return { source, nodes };
}
