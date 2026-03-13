import { describe, expect, it } from "vitest";

import { estimateTimelineMessageHeight, estimateTimelineWorkGroupHeight } from "./timelineHeight";

describe("estimateTimelineMessageHeight", () => {
  it("uses assistant sizing rules for assistant messages", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "assistant",
        text: "a".repeat(144),
      }),
    ).toBe(122);
  });

  it("uses assistant sizing rules for system messages", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "system",
        text: "a".repeat(144),
      }),
    ).toBe(122);
  });

  it("adds one attachment row for one or two user attachments", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "hello",
        attachments: [{ id: "1" }],
      }),
    ).toBe(323);

    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "hello",
        attachments: [{ id: "1" }, { id: "2" }],
      }),
    ).toBe(323);
  });

  it("adds a second attachment row for three or four user attachments", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "hello",
        attachments: [{ id: "1" }, { id: "2" }, { id: "3" }],
      }),
    ).toBe(551);

    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "hello",
        attachments: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }],
      }),
    ).toBe(551);
  });

  it("does not cap long user message estimates", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "a".repeat(56 * 120),
      }),
    ).toBe(2735);
  });

  it("counts explicit newlines for user message estimates", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "first\nsecond\nthird",
      }),
    ).toBe(139);
  });

  it("uses narrower width to increase user line wrapping", () => {
    const message = {
      role: "user" as const,
      text: "a".repeat(52),
    };

    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 320 })).toBe(117);
    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 768 })).toBe(95);
  });

  it("does not clamp user wrapping too aggressively on very narrow layouts", () => {
    const message = {
      role: "user" as const,
      text: "a".repeat(20),
    };

    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 100 })).toBe(161);
    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 320 })).toBe(95);
  });

  it("uses narrower width to increase assistant line wrapping", () => {
    const message = {
      role: "assistant" as const,
      text: "a".repeat(200),
    };

    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 320 })).toBe(188);
    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 768 })).toBe(122);
  });
});

describe("estimateTimelineWorkGroupHeight", () => {
  it("accounts for visible entries, header chrome, and row spacing", () => {
    expect(
      estimateTimelineWorkGroupHeight(
        Array.from({ length: 6 }, (_, index) => ({
          tone: "tool" as const,
          command: `command-${index}`,
        })),
        { maxVisibleEntries: 6 },
      ),
    ).toBe(208);
  });

  it("uses the collapsed visible-entry limit and header when the group overflows", () => {
    expect(
      estimateTimelineWorkGroupHeight(
        Array.from({ length: 8 }, (_, index) => ({
          tone: "tool" as const,
          command: `command-${index}`,
        })),
        { maxVisibleEntries: 6, expanded: false },
      ),
    ).toBe(236);
  });

  it("accounts for wrapped changed-file chips based on width", () => {
    const groupedEntries = [
      {
        tone: "info" as const,
        detail: "Updated files",
        changedFiles: ["a.ts", "b.ts", "c.ts", "d.ts"],
      },
    ];

    expect(
      estimateTimelineWorkGroupHeight(groupedEntries, {
        timelineWidthPx: 320,
      }),
    ).toBe(178);

    expect(
      estimateTimelineWorkGroupHeight(groupedEntries, {
        timelineWidthPx: 768,
      }),
    ).toBe(112);
  });
});
