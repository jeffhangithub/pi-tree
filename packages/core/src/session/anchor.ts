/**
 * anchor.ts — validation/normalization for the P5 unified anchor model.
 *
 * Anchors arrive from the client as untrusted JSON on /message and
 * /message/stream requests. This module normalizes them into the strict
 * `UnifiedAnchor` shape (rejecting garbage before it reaches session
 * storage) and is exported from @pi-tree/core for both server and client use.
 */

import type {
  UnifiedAnchor,
  PdfNodeAnchor,
  ContentNodeAnchor,
} from "../types/index.js";

/** Cap stored quote/section sizes so a hostile client can't bloat the JSONL. */
const MAX_QUOTE_LENGTH = 2000;
const MAX_SECTION_LENGTH = 500;

function clampString(value: unknown, max: number): string {
  const s = typeof value === "string" ? value : "";
  return s.length > max ? s.slice(0, max) : s;
}

export function isPdfNodeAnchor(value: UnifiedAnchor | null | undefined): value is PdfNodeAnchor {
  return value?.kind === "pdf";
}

export function isContentNodeAnchor(value: UnifiedAnchor | null | undefined): value is ContentNodeAnchor {
  return value?.kind === "content";
}

/**
 * Parse untrusted input into a valid unified anchor, or null.
 * - pdf:     requires a positive integer page; quote/section are strings.
 * - content: requires a non-empty nodeId; quote is a string.
 */
export function normalizeUnifiedAnchor(input: unknown): UnifiedAnchor | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;

  if (raw.kind === "pdf") {
    const page = Number(raw.page);
    if (!Number.isInteger(page) || page < 1) return null;
    return {
      kind: "pdf",
      page,
      quote: clampString(raw.quote, MAX_QUOTE_LENGTH),
      section: clampString(raw.section, MAX_SECTION_LENGTH),
    };
  }

  if (raw.kind === "content") {
    if (typeof raw.nodeId !== "string" || raw.nodeId.trim() === "") return null;
    return {
      kind: "content",
      nodeId: raw.nodeId.trim(),
      quote: clampString(raw.quote, MAX_QUOTE_LENGTH),
    };
  }

  return null;
}
