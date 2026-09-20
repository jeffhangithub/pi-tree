/**
 * Anchor attach tests — P5 dual-anchor closed loop, server side.
 *
 * Verifies that TreeManager.handleMessage/handleMessageStreaming attach a
 * pending anchor to the question node the send created (and only then),
 * and that the anchor then rides along on the client-facing tree.
 */

import { describe, it, expect, vi } from "vitest";
import type { AnnotatedTreeNode, UnifiedAnchor } from "@pi-tree/core";
import { TreeManager } from "../services/tree-manager.js";
import { PiSession } from "@pi-tree/core";

const PDF_ANCHOR: UnifiedAnchor = {
  kind: "pdf",
  page: 4,
  quote: "the loss function",
  section: "3.2",
};

function userNode(id: string, label: string, children: AnnotatedTreeNode[] = []): AnnotatedTreeNode {
  return {
    entryId: id,
    parentId: "root",
    label,
    source: "user",
    status: "active",
    messageCount: 0,
    isCurrent: false,
    children,
  };
}

function aiNode(id: string, label: string, children: AnnotatedTreeNode[] = []): AnnotatedTreeNode {
  return {
    entryId: id,
    parentId: "root",
    label: `✦ ${label}`,
    source: "auto",
    status: "active",
    messageCount: 0,
    isCurrent: false,
    children,
  };
}

function createMockPiSession(preUserEntryId: string, postUserEntryId: string) {
  let currentTree: AnnotatedTreeNode[] = [
    userNode(preUserEntryId, "question", [aiNode("a1", "answer")]),
  ];
  const setAnchorCalls: Array<[string, UnifiedAnchor]> = [];

  const mock = {
    getAnnotatedTree: vi.fn(() => currentTree),
    simpleBranch: vi.fn(),
    sendMessage: vi.fn(async () => {
      currentTree = [
        userNode(postUserEntryId, "question", [aiNode("a2", "answer")]),
      ];
      return { response: "AI response", entryId: "a2" };
    }),
    sendMessageStreaming: vi.fn(
      async (_msg: string, onToken: (t: string) => Promise<void>) => {
        currentTree = [
          userNode(postUserEntryId, "question", [aiNode("a2", "answer")]),
        ];
        await onToken("AI response");
        return { response: "AI response", entryId: "a2" };
      },
    ),
    getMessageContentMap: vi.fn(
      () =>
        new Map<string, { role: string; content: string; timestamp: string }>([
          [postUserEntryId, { role: "user", content: "question", timestamp: "2026-01-01T00:00:00Z" }],
          ["a2", { role: "assistant", content: "answer", timestamp: "2026-01-01T00:00:00Z" }],
        ]),
    ),
    getBreadcrumb: vi.fn(() => [{ entryId: postUserEntryId, label: "question" }]),
    findLastUserMessageEntry: vi.fn(() => postUserEntryId),
    setAnchor: vi.fn((entryId: string, anchor: UnifiedAnchor) => {
      setAnchorCalls.push([entryId, anchor]);
    }),
    _setPreUserEntryId: (id: string) => {
      (mock.findLastUserMessageEntry as ReturnType<typeof vi.fn>).mockImplementation(() => id);
    },
    _setAnchorCalls: setAnchorCalls,
  };

  // The PRE-send capture happens before sendMessage runs; the mock must
  // return the pre-send id for the first call, then the post-send id.
  let calls = 0;
  const originalImpl = mock.findLastUserMessageEntry.getMockImplementation();
  mock.findLastUserMessageEntry.mockImplementation(() => {
    calls++;
    if (calls === 1) return preUserEntryId;
    return originalImpl ? originalImpl() : postUserEntryId;
  });

  return mock;
}

describe("TreeManager — P5 anchor attach", () => {
  it("attaches a pdf anchor to the newly created question node on handleMessage", async () => {
    const mock = createMockPiSession("q1", "q2");
    const tm = TreeManager._createForTest(mock as unknown as PiSession);

    await tm.handleMessage("explain this", "q1", { anchor: PDF_ANCHOR });

    expect(mock.setAnchor).toHaveBeenCalledTimes(1);
    expect(mock.setAnchor).toHaveBeenCalledWith("q2", PDF_ANCHOR);
  });

  it("attaches the anchor on the streaming path too", async () => {
    const mock = createMockPiSession("q1", "q2");
    const tm = TreeManager._createForTest(mock as unknown as PiSession);

    await tm.handleMessageStreaming(
      "explain this",
      "q1",
      {
        onToken: vi.fn(async () => {}),
        onTreeUpdate: vi.fn(async () => {}),
        onDone: vi.fn(async () => {}),
      },
      { anchor: PDF_ANCHOR },
    );

    expect(mock.setAnchor).toHaveBeenCalledWith("q2", PDF_ANCHOR);
  });

  it("does not attach when the send created no new user node", async () => {
    // Same id before and after the send → e.g. the no-agent fallback that
    // records no entries. The anchor must NOT be misattached.
    const mock = createMockPiSession("q1", "q1");
    const tm = TreeManager._createForTest(mock as unknown as PiSession);

    await tm.handleMessage("explain this", "q1", { anchor: PDF_ANCHOR });

    expect(mock.setAnchor).not.toHaveBeenCalled();
  });

  it("does not attach (and does not query) without an anchor", async () => {
    const mock = createMockPiSession("q1", "q2");
    const tm = TreeManager._createForTest(mock as unknown as PiSession);

    await tm.handleMessage("plain message", "q1");

    expect(mock.setAnchor).not.toHaveBeenCalled();
    expect(mock.findLastUserMessageEntry).not.toHaveBeenCalled();
  });

  it("carries node anchors into the client-facing tree (annotatedToView)", () => {
    const mock = createMockPiSession("q1", "q1");
    // Put the anchor directly on the annotated node to test view mapping.
    const currentTree: AnnotatedTreeNode[] = [
      userNode("q1", "question", [aiNode("a1", "answer")]),
    ];
    currentTree[0].anchor = PDF_ANCHOR;
    mock.getAnnotatedTree.mockReturnValue(currentTree);

    const tm = TreeManager._createForTest(mock as unknown as PiSession);
    const state = tm.getSessionState(null);

    expect(state.tree.anchor).toEqual(PDF_ANCHOR);
  });
});
