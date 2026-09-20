import type { TreeNodeView } from "@pi-tree/core/types";

/**
 * Build a native tooltip string for a tree node.
 * Shows the label (truncated to 200 chars) and optional summary (truncated to 150 chars).
 * Returns undefined for short, fully-visible labels with no summary.
 */
export function buildTooltip(node: TreeNodeView): string | undefined {
  const label = node.label;
  if (label.length < 40 && !node.summary) return undefined;

  let tip = label.length > 200 ? label.slice(0, 200) + "…" : label;
  if (node.summary) {
    const sum = node.summary.length > 150 ? node.summary.slice(0, 150) + "…" : node.summary;
    tip += "\n—\n" + sum;
  }
  return tip;
}

/**
 * Find a tree node by ID (DFS). Local copy of @pi-tree/core's findNode —
 * keeps the client bundle free of the core session machinery.
 */
export function findNode(tree: TreeNodeView, nodeId: string): TreeNodeView | null {
  if (tree.id === nodeId) return tree;
  for (const child of tree.children ?? []) {
    const found = findNode(child, nodeId);
    if (found) return found;
  }
  return null;
}
