import { describe, it, expect } from "vitest";
import {
  computeHighlightRects,
  type TextSpanMetrics,
} from "../ui/highlight";

function span(
  text: string,
  top: number,
  left: number,
  width: number,
  height = 14,
): TextSpanMetrics {
  return { text, top, left, width, height };
}

describe("computeHighlightRects", () => {
  it("returns [] for an empty or absent quote", () => {
    const spans = [span("hello world", 10, 0, 80)];
    expect(computeHighlightRects(spans, "")).toEqual([]);
    expect(computeHighlightRects(spans, "missing")).toEqual([]);
    expect(computeHighlightRects([], "hello")).toEqual([]);
  });

  it("covers a single-span quote", () => {
    const spans = [span("the loss function is here", 100, 20, 160)];
    const rects = computeHighlightRects(spans, "loss function");
    expect(rects).toHaveLength(1);
    expect(rects[0].top).toBe(98); // top - 2
    expect(rects[0].height).toBe(18); // height + 4
  });

  it("joins spans across a line and merges them into one rect", () => {
    const spans = [
      span("Deep learning ", 50, 10, 90),
      span("minimizes", 50, 100, 60),
      span(" the loss", 50, 160, 55),
    ];
    const rects = computeHighlightRects(spans, "minimizes the loss");
    expect(rects).toHaveLength(1);
    expect(rects[0].left).toBe(100);
    expect(rects[0].width).toBe(160 + 55 - 100);
    expect(rects[0].top).toBe(48);
  });

  it("splits a multi-line quote into one rect per visual line", () => {
    const spans = [
      span("First line continues", 0, 0, 140),
      span("Second line starts", 20, 0, 140),
      span(" here", 20, 140, 40),
    ];
    const rects = computeHighlightRects(spans, "continues Second line starts");
    expect(rects).toHaveLength(2);
    expect(rects[0].top).toBe(-2);
    expect(rects[1].top).toBe(18);
  });

  it("matches quotes despite collapsed whitespace inside spans", () => {
    const spans = [
      span("  the   loss ", 10, 0, 100),
      span(" function", 10, 100, 60),
    ];
    const rects = computeHighlightRects(spans, "the loss function");
    expect(rects).toHaveLength(1);
    expect(rects[0].left).toBe(0);
    expect(rects[0].width).toBe(160);
  });

  it("does not match quotes glued across line gaps", () => {
    // Two separate visual lines: "abc" / "def". Joined as "abc def", so a
    // quote can only match within real word flow, never across the gap.
    const spans = [span("abc", 10, 0, 30), span("def", 20, 0, 30)];
    expect(computeHighlightRects(spans, "bcd")).toEqual([]);
    expect(computeHighlightRects(spans, "abcdef")).toEqual([]);
    // Same visual line → contiguous text → matches across spans.
    const sameLine = [span("abc", 10, 0, 30), span(" def", 10, 30, 30)];
    expect(computeHighlightRects(sameLine, "bc de")).toHaveLength(1);
  });

  it("selects only the spans overlapping the first occurrence", () => {
    const spans = [
      span("loss function appears again loss function", 10, 0, 300),
    ];
    const rects = computeHighlightRects(spans, "loss function");
    expect(rects).toHaveLength(1);
    expect(rects[0].width).toBe(300); // span-level granularity: whole span covered
  });
});
