import { describe, it, expect } from "vitest";
import type { TreeNodeView, UnifiedAnchor } from "@pi-tree/core/types";
import { buildReadingRecord } from "../reading-record.js";

function node(
  id: string,
  label: string,
  children: TreeNodeView[] = [],
  extra: Partial<TreeNodeView> = {},
): TreeNodeView {
  return {
    id,
    parentId: null,
    label,
    status: "active",
    messageCount: 0,
    children,
    isCurrent: false,
    ...extra,
  };
}

const PDF_ANCHOR: UnifiedAnchor = {
  kind: "pdf",
  page: 4,
  quote: "the loss function",
  section: "3.2 Training Objective",
};
const CONTENT_ANCHOR: UnifiedAnchor = {
  kind: "content",
  nodeId: "a1",
  quote: "anchoring bias",
};

function contents(entries: Array<[string, string, string]>): Record<string, { role: string; content: string }> {
  const map: Record<string, { role: string; content: string }> = {};
  for (const [id, role, content] of entries) map[id] = { role, content };
  return map;
}

describe("buildReadingRecord", () => {
  it("flattens a linear question→answer→question chain with anchors", () => {
    // root → q1(user) → a1(assistant) → q2(user) → a2(assistant)
    const a2 = node("a2", "✦ answer two");
    const q2 = node("q2", "why?", [a2], { anchor: PDF_ANCHOR });
    const a1 = node("a1", "✦ answer one", [q2]);
    const q1 = node("q1", "what is this?", [a1], { anchor: CONTENT_ANCHOR });
    const root = node("root", "source", [q1]);

    const record = buildReadingRecord(
      root,
      contents([
        ["q1", "user", "what is this?"],
        ["a1", "assistant", "answer one"],
        ["q2", "user", "why?"],
        ["a2", "assistant", "answer two"],
      ]),
      new Map<string, UnifiedAnchor>([
        ["q1", CONTENT_ANCHOR],
        ["q2", PDF_ANCHOR],
      ]),
      "paper.pdf",
    );

    expect(record.source).toBe("paper.pdf");
    expect(record.nodes).toEqual([
      {
        id: "q1",
        parentId: null,
        question: "what is this?",
        answer: "answer one",
        anchor: CONTENT_ANCHOR,
      },
      {
        id: "q2",
        parentId: "q1",
        question: "why?",
        answer: "answer two",
        anchor: PDF_ANCHOR,
      },
    ]);
  });

  it("uses the nearest emitted question ancestor as parentId across forks", () => {
    // root → q1 → (fork) q2a, q2b
    const q2a = node("q2a", "branch A?");
    const q2b = node("q2b", "branch B?");
    const q1 = node("q1", "first?", [node("a1", "✦ ans", [q2a, q2b])]);
    const root = node("root", "source", [q1]);

    const record = buildReadingRecord(
      root,
      contents([
        ["q1", "user", "first?"],
        ["a1", "assistant", "ans"],
        ["q2a", "user", "branch A?"],
        ["q2b", "user", "branch B?"],
      ]),
      new Map(),
      "src",
    );

    expect(record.nodes.map((n) => [n.id, n.parentId])).toEqual([
      ["q1", null],
      ["q2a", "q1"],
      ["q2b", "q1"],
    ]);
  });

  it("leaves answer empty when a question has no assistant child", () => {
    const q2 = node("q2", "follow-up?");
    const q1 = node("q1", "question?", [q2]); // no AI answer
    const root = node("root", "source", [q1]);

    const record = buildReadingRecord(
      root,
      contents([
        ["q1", "user", "question?"],
        ["q2", "user", "follow-up?"],
      ]),
      new Map(),
      "src",
    );

    expect(record.nodes[0].answer).toBe("");
    expect(record.nodes[1].answer).toBe("");
  });

  it("skips non-user nodes (topic nodes, assistant nodes) and yields null anchors", () => {
    const a1 = node("a1", "✦ answer");
    const q1 = node("q1", "question?", [a1]);
    const root = node("root", "topic root", [q1]);

    const record = buildReadingRecord(
      root,
      contents([
        ["q1", "user", "question?"],
        ["a1", "assistant", "answer"],
      ]),
      new Map(),
      "src",
    );

    expect(record.nodes).toEqual([
      { id: "q1", parentId: null, question: "question?", answer: "answer", anchor: null },
    ]);
  });

  it("reads anchors from a plain object map as well as a Map", () => {
    const q1 = node("q1", "question?", [], { anchor: PDF_ANCHOR });
    const root = node("root", "source", [q1]);

    const record = buildReadingRecord(
      root,
      contents([["q1", "user", "question?"]]),
      { q1: PDF_ANCHOR },
      "src",
    );
    expect(record.nodes[0].anchor).toEqual(PDF_ANCHOR);
  });
});
