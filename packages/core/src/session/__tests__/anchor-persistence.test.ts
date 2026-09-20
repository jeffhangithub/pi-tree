import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Anchor persistence tests — verify that P5 unified anchors are stored as
 * append-only Pi SDK custom entries (session JSONL), restored on resume,
 * and locate the question node a send just created.
 *
 * The Pi SDK is mocked (mirroring pi-session.test.ts) so no real agent is
 * created; the assertions target the custom-entry protocol itself.
 */

(globalThis as any).__anchorMockState = {
  mockReload: vi.fn().mockResolvedValue(undefined),
  mockAppendCustomEntry: vi.fn(),
  mockGetEntries: vi.fn().mockReturnValue([]),
  mockGetLeafId: vi.fn().mockReturnValue("leaf-123"),
  mockBranch: vi.fn(),
  mockGetBranch: vi.fn().mockReturnValue([]),
};

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  const state = () => (globalThis as any).__anchorMockState ?? {};
  return {
    ...actual,
    getAgentDir: vi.fn().mockReturnValue("/mock/agent/dir"),
    DefaultResourceLoader: class {
      constructor(_options: any) {}
      async reload() {
        return state().mockReload();
      }
      get extensionsResult() {
        return { extensions: [], errors: [] };
      }
    },
    SessionManager: {
      create: vi.fn().mockImplementation(() => ({
        getEntries: () => state().mockGetEntries(),
        getLeafId: () => state().mockGetLeafId(),
        getBranch: (id: string) => state().mockGetBranch(id),
        appendCustomEntry: (...args: any[]) => state().mockAppendCustomEntry(...args),
        branch: (...args: any[]) => state().mockBranch(...args),
      })),
      open: vi.fn().mockImplementation(() => ({
        getEntries: () => state().mockGetEntries(),
        getLeafId: () => state().mockGetLeafId(),
        getBranch: (id: string) => state().mockGetBranch(id),
        appendCustomEntry: (...args: any[]) => state().mockAppendCustomEntry(...args),
        branch: (...args: any[]) => state().mockBranch(...args),
      })),
    },
    SettingsManager: {
      create: vi.fn().mockReturnValue({}),
    },
    createAgentSession: vi.fn().mockImplementation(async () => ({
      session: {
        setAutoCompactionEnabled: vi.fn(),
      },
    })),
  };
});

import { PiSession } from "../pi-session.js";
import type { UnifiedAnchor } from "../../types/index.js";

const PDF_ANCHOR: UnifiedAnchor = {
  kind: "pdf",
  page: 4,
  quote: "the loss function",
  section: "3.2",
};

function state() {
  return (globalThis as any).__anchorMockState;
}

describe("PiSession unified anchor persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state().mockReload.mockClear();
    state().mockAppendCustomEntry.mockClear();
    state().mockGetEntries.mockClear().mockReturnValue([]);
    state().mockGetLeafId.mockClear().mockReturnValue("leaf-123");
    state().mockBranch.mockClear();
    state().mockGetBranch.mockClear().mockReturnValue([]);
  });

  it("setAnchor appends a kind:\"anchor\" custom entry and restores the leaf", async () => {
    const piSession = await PiSession.create(
      "user-1",
      "paper-1",
      "/mock/library",
      "/mock/data",
      { resumeSession: "/mock/session.jsonl" },
    );

    piSession.setAnchor("q1", PDF_ANCHOR);

    expect(state().mockAppendCustomEntry).toHaveBeenCalledWith("pi-tree", {
      kind: "anchor",
      targetEntryId: "q1",
      anchor: PDF_ANCHOR,
    });
    // Leaf position must be restored so the anchor entry doesn't become a
    // parasitic tree node.
    expect(state().mockBranch).toHaveBeenCalledWith("leaf-123");
    // In-memory cache reflects the anchor immediately.
    expect(piSession.getAnchor("q1")).toEqual(PDF_ANCHOR);
    expect(piSession.getAllAnchors().get("q1")).toEqual(PDF_ANCHOR);
  });

  it("restores anchors from custom entries on resume (rebuildTopicCache)", async () => {
    state().mockGetEntries.mockReturnValue([
      {
        type: "custom",
        id: "c1",
        customType: "pi-tree",
        data: { kind: "anchor", targetEntryId: "q1", anchor: PDF_ANCHOR },
      },
      {
        type: "custom",
        id: "c2",
        customType: "pi-tree",
        data: {
          kind: "anchor",
          targetEntryId: "q2",
          anchor: { kind: "content", nodeId: "a1", quote: "bias" },
        },
      },
    ]);

    const piSession = await PiSession.create(
      "user-1",
      "paper-1",
      "/mock/library",
      "/mock/data",
      { resumeSession: "/mock/session.jsonl" },
    );

    expect(piSession.getAnchor("q1")).toEqual(PDF_ANCHOR);
    expect(piSession.getAnchor("q2")).toEqual({ kind: "content", nodeId: "a1", quote: "bias" });
    expect(piSession.getAnchor("missing")).toBeNull();
  });

  it("findLastUserMessageEntry walks the leaf branch back to the last user message", async () => {
    state().mockGetLeafId.mockReturnValue("leaf-1");
    state().mockGetBranch.mockReturnValue([
      { type: "custom", id: "root" },
      { type: "message", id: "u1", message: { role: "user" } },
      { type: "message", id: "a1", message: { role: "assistant" } },
      { type: "tool_result", id: "t1" },
      { type: "message", id: "u2", message: { role: "user" } },
      { type: "message", id: "a2", message: { role: "assistant" } },
    ]);

    const piSession = await PiSession.create(
      "user-1",
      "paper-1",
      "/mock/library",
      "/mock/data",
      { resumeSession: "/mock/session.jsonl" },
    );

    // The assistant leaf entry is skipped; u2 is the question node.
    expect(piSession.findLastUserMessageEntry()).toBe("u2");
  });

  it("findLastUserMessageEntry returns null when no user message exists", async () => {
    state().mockGetLeafId.mockReturnValue("leaf-1");
    state().mockGetBranch.mockReturnValue([
      { type: "custom", id: "root" },
      { type: "message", id: "a1", message: { role: "assistant" } },
    ]);

    const piSession = await PiSession.create(
      "user-1",
      "paper-1",
      "/mock/library",
      "/mock/data",
      { resumeSession: "/mock/session.jsonl" },
    );

    expect(piSession.findLastUserMessageEntry()).toBeNull();
  });
});
