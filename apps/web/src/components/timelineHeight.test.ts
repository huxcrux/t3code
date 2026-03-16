import { describe, expect, it } from "vitest";

import { appendTerminalContextsToPrompt } from "../lib/terminalContext";
import { buildInlineTerminalContextText } from "./chat/userMessageTerminalContexts";
import { estimateTimelineMessageHeight, estimateTimelineRowHeight } from "./timelineHeight";
import {
  buildGeneratedTimelineHeightRows,
  generateTimelineHeightEdgeCases,
  generateTimelineHeightThreadCases,
  makeTimelineHeightAttachments,
  type GeneratedTimelineHeightResolvedRow,
} from "./timelineHeight.generated";

function countLines(text: string): number {
  return text.split("\n").length;
}

function getGeneratedRow(
  rows: GeneratedTimelineHeightResolvedRow[],
  id: string,
): GeneratedTimelineHeightResolvedRow["input"] {
  const row = rows.find((candidate) => candidate.id === id);
  expect(row, `missing generated row ${id}`).toBeDefined();
  return row!.input;
}

function getGeneratedMessageRow(
  rows: GeneratedTimelineHeightResolvedRow[],
  id: string,
): Extract<GeneratedTimelineHeightResolvedRow["input"], { kind: "message" }> {
  const row = getGeneratedRow(rows, id);
  expect(row.kind, `generated row ${id} should be a message row`).toBe("message");
  return row as Extract<GeneratedTimelineHeightResolvedRow["input"], { kind: "message" }>;
}

function getGeneratedWorkRow(
  rows: GeneratedTimelineHeightResolvedRow[],
  id: string,
): Extract<GeneratedTimelineHeightResolvedRow["input"], { kind: "work" }> {
  const row = getGeneratedRow(rows, id);
  expect(row.kind, `generated row ${id} should be a work row`).toBe("work");
  return row as Extract<GeneratedTimelineHeightResolvedRow["input"], { kind: "work" }>;
}

function getGeneratedPlanRow(
  rows: GeneratedTimelineHeightResolvedRow[],
  id: string,
): Extract<GeneratedTimelineHeightResolvedRow["input"], { kind: "proposed-plan" }> {
  const row = getGeneratedRow(rows, id);
  expect(row.kind, `generated row ${id} should be a proposed-plan row`).toBe("proposed-plan");
  return row as Extract<GeneratedTimelineHeightResolvedRow["input"], { kind: "proposed-plan" }>;
}

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
    ).toBe(346);

    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "hello",
        attachments: [{ id: "1" }, { id: "2" }],
      }),
    ).toBe(346);
  });

  it("adds a second attachment row for three or four user attachments", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "hello",
        attachments: [{ id: "1" }, { id: "2" }, { id: "3" }],
      }),
    ).toBe(574);

    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "hello",
        attachments: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }],
      }),
    ).toBe(574);
  });

  it("does not cap long user message estimates", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "a".repeat(56 * 120),
      }),
    ).toBe(2736);
  });

  it("counts explicit newlines for user message estimates", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "first\nsecond\nthird",
      }),
    ).toBe(162);
  });

  it("adds terminal context chrome without counting the hidden block as message text", () => {
    const prompt = appendTerminalContextsToPrompt("Investigate this", [
      {
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 40,
        lineEnd: 43,
        text: [
          "git status",
          "M apps/web/src/components/chat/MessagesTimeline.tsx",
          "?? tmp",
          "",
        ].join("\n"),
      },
    ]);

    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: prompt,
      }),
    ).toBe(
      estimateTimelineMessageHeight({
        role: "user",
        text: `${buildInlineTerminalContextText([{ header: "Terminal 1 lines 40-43" }])} Investigate this`,
      }),
    );
  });

  it("uses narrower width to increase user line wrapping", () => {
    const message = {
      role: "user" as const,
      text: "a".repeat(52),
    };

    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 320 })).toBe(140);
    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 768 })).toBe(118);
  });

  it("does not clamp user wrapping too aggressively on very narrow layouts", () => {
    const message = {
      role: "user" as const,
      text: "a".repeat(20),
    };

    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 100 })).toBe(184);
    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 320 })).toBe(118);
  });

  it("uses narrower width to increase assistant line wrapping", () => {
    const message = {
      role: "assistant" as const,
      text: "a".repeat(200),
    };

    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 320 })).toBe(188);
    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 768 })).toBe(122);
  });

  it("keeps generated user message estimates monotonic across widths and attachment bands", () => {
    for (const generatedCase of generateTimelineHeightThreadCases()) {
      const generatedMessage = getGeneratedMessageRow(
        buildGeneratedTimelineHeightRows(generatedCase),
        generatedCase.ids.user,
      ).message;
      const message = {
        role: "user" as const,
        text: generatedMessage.text,
      };
      const lineCount = countLines(message.text);

      const wideHeight = estimateTimelineMessageHeight(message, { timelineWidthPx: 768 });
      const narrowHeight = estimateTimelineMessageHeight(message, { timelineWidthPx: 320 });
      const ultraNarrowHeight = estimateTimelineMessageHeight(message, { timelineWidthPx: 120 });

      expect(
        lineCount,
        `user case ${generatedCase.index} should stay within the generated range`,
      ).toBeGreaterThanOrEqual(4);
      expect(
        lineCount,
        `user case ${generatedCase.index} should stay within the generated range`,
      ).toBeLessThanOrEqual(50);

      expect(
        narrowHeight,
        `user case ${generatedCase.index} should not shrink on a narrower width`,
      ).toBeGreaterThanOrEqual(wideHeight);
      expect(
        ultraNarrowHeight,
        `user case ${generatedCase.index} should not shrink on an ultra-narrow width`,
      ).toBeGreaterThanOrEqual(narrowHeight);

      const noAttachmentHeight = estimateTimelineMessageHeight(message);
      const oneAttachmentHeight = estimateTimelineMessageHeight({
        ...message,
        attachments: makeTimelineHeightAttachments(1),
      });
      const twoAttachmentHeight = estimateTimelineMessageHeight({
        ...message,
        attachments: makeTimelineHeightAttachments(2),
      });
      const threeAttachmentHeight = estimateTimelineMessageHeight({
        ...message,
        attachments: makeTimelineHeightAttachments(3),
      });
      const fourAttachmentHeight = estimateTimelineMessageHeight({
        ...message,
        attachments: makeTimelineHeightAttachments(4),
      });

      expect(
        oneAttachmentHeight - noAttachmentHeight,
        `user case ${generatedCase.index} first attachment row delta`,
      ).toBe(228);
      expect(
        twoAttachmentHeight,
        `user case ${generatedCase.index} two attachments should stay in the first row`,
      ).toBe(oneAttachmentHeight);
      expect(
        threeAttachmentHeight - oneAttachmentHeight,
        `user case ${generatedCase.index} second attachment row delta`,
      ).toBe(228);
      expect(
        fourAttachmentHeight,
        `user case ${generatedCase.index} four attachments should stay in the second row`,
      ).toBe(threeAttachmentHeight);
    }
  });

  it("keeps generated assistant and system message estimates aligned and width-sensitive", () => {
    for (const generatedCase of generateTimelineHeightThreadCases()) {
      const rows = buildGeneratedTimelineHeightRows(generatedCase);
      const assistantMessage = getGeneratedMessageRow(
        rows,
        generatedCase.ids.assistantBaseline,
      ).message;
      const systemMessage = getGeneratedMessageRow(rows, generatedCase.ids.system).message;
      const lineCount = countLines(assistantMessage.text);

      const wideAssistantHeight = estimateTimelineMessageHeight(assistantMessage, {
        timelineWidthPx: 768,
      });
      const narrowAssistantHeight = estimateTimelineMessageHeight(assistantMessage, {
        timelineWidthPx: 320,
      });

      expect(
        lineCount,
        `assistant case ${generatedCase.index} should stay within the generated range`,
      ).toBeGreaterThanOrEqual(4);
      expect(
        lineCount,
        `assistant case ${generatedCase.index} should stay within the generated range`,
      ).toBeLessThanOrEqual(50);
      expect(
        narrowAssistantHeight,
        `assistant case ${generatedCase.index} should not shrink on a narrower width`,
      ).toBeGreaterThanOrEqual(wideAssistantHeight);
      expect(
        estimateTimelineMessageHeight(systemMessage),
        `system case ${generatedCase.index} should match assistant sizing`,
      ).toBe(estimateTimelineMessageHeight(assistantMessage));
    }
  });
});

describe("estimateTimelineRowHeight", () => {
  it("keeps a plain assistant row at the baseline height", () => {
    expect(
      estimateTimelineRowHeight({
        kind: "message",
        message: {
          role: "assistant",
          text: "a".repeat(144),
        },
      }),
    ).toBe(122);
  });

  it("gives structured assistant markdown more height than plain prose", () => {
    const plainHeight = estimateTimelineRowHeight({
      kind: "message",
      message: {
        role: "assistant",
        text: "Plain assistant prose ".repeat(12),
      },
    });
    const structuredHeight = estimateTimelineRowHeight({
      kind: "message",
      message: {
        role: "assistant",
        text: [
          "# Heading",
          "",
          "Assistant prose for the same rough amount of text.",
          "",
          "- item one",
          "- item two",
          "1. item three",
          "2. item four",
        ].join("\n"),
      },
    });

    expect(structuredHeight).toBeGreaterThan(plainHeight);
  });

  it("treats fenced code blocks as taller than plain paragraphs", () => {
    const paragraphHeight = estimateTimelineRowHeight({
      kind: "message",
      message: {
        role: "assistant",
        text: "Code explanation paragraph ".repeat(10),
      },
    });
    const fencedCodeHeight = estimateTimelineRowHeight({
      kind: "message",
      message: {
        role: "assistant",
        text: [
          "```ts",
          "export function multiply(left: number, right: number) {",
          "  const product = left * right;",
          "  if (product > 100) {",
          "    return Math.round(product / 10) * 10;",
          "  }",
          "  return product;",
          "}",
          "",
          "export function format(value: number) {",
          "  return `value:${value}`;",
          "}",
          "```",
        ].join("\n"),
      },
    });

    expect(fencedCodeHeight).toBeGreaterThan(paragraphHeight);
  });

  it("keeps assistant markdown width-sensitive", () => {
    const row = {
      kind: "message" as const,
      message: {
        role: "assistant" as const,
        text: [
          "# Heading",
          "",
          "Quoted context that should wrap more on a narrow layout.",
          "",
          "> nested note",
          "",
          "| file | additions | deletions |",
          "| --- | ---: | ---: |",
          "| timelineHeight.ts | 12 | 4 |",
        ].join("\n"),
      },
    };

    expect(estimateTimelineRowHeight(row, { timelineWidthPx: 320 })).toBeGreaterThan(
      estimateTimelineRowHeight(row, { timelineWidthPx: 768 }),
    );
  });

  it("keeps system messages on the assistant sizing path", () => {
    const systemHeight = estimateTimelineRowHeight({
      kind: "message",
      message: {
        role: "system",
        text: "a".repeat(144),
      },
    });
    const assistantHeight = estimateTimelineRowHeight({
      kind: "message",
      message: {
        role: "assistant",
        text: "a".repeat(144),
      },
    });

    expect(systemHeight).toBe(assistantHeight);
  });

  it("adds the completion divider height exactly once", () => {
    const baselineHeight = estimateTimelineRowHeight({
      kind: "message",
      message: {
        role: "assistant",
        text: "completion divider baseline",
      },
    });
    const dividerHeight = estimateTimelineRowHeight({
      kind: "message",
      message: {
        role: "assistant",
        text: "completion divider baseline",
      },
      showCompletionDivider: true,
    });

    expect(dividerHeight - baselineHeight).toBe(48);
  });

  it("adds changed-files summary height for assistant rows", () => {
    const baselineHeight = estimateTimelineRowHeight({
      kind: "message",
      message: {
        role: "assistant",
        text: "Changed files summary baseline",
      },
    });
    const withDiffSummaryHeight = estimateTimelineRowHeight({
      kind: "message",
      message: {
        role: "assistant",
        text: "Changed files summary baseline",
      },
      diffSummary: {
        files: [
          {
            path: "apps/web/src/components/chat/MessagesTimeline.tsx",
            additions: 10,
            deletions: 2,
          },
          { path: "apps/web/src/components/timelineHeight.ts", additions: 18, deletions: 7 },
          { path: "apps/web/src/components/chat/ChangedFilesTree.tsx", additions: 5, deletions: 1 },
          { path: "apps/web/src/lib/turnDiffTree.ts", additions: 3, deletions: 0 },
        ],
      },
    });

    expect(withDiffSummaryHeight).toBeGreaterThan(baselineHeight);
  });

  it("keeps tool-only work groups compact when there is no overflow", () => {
    expect(
      estimateTimelineRowHeight({
        kind: "work",
        groupedEntries: [
          { label: "Step 1", tone: "tool" },
          { label: "Step 2", tone: "tool" },
          { label: "Step 3", tone: "tool" },
        ],
      }),
    ).toBe(132);
  });

  it("adds the work-group header for mixed-tone rows", () => {
    expect(
      estimateTimelineRowHeight({
        kind: "work",
        groupedEntries: [
          { label: "Thinking", tone: "thinking" },
          { label: "Tool step", tone: "tool" },
        ],
      }),
    ).toBe(126);
  });

  it("uses only the visible entry window for collapsed overflow work groups", () => {
    const overflowEntries = Array.from({ length: 8 }, (_, index) => ({
      label: `Overflow step ${index + 1}`,
      tone: "tool" as const,
    }));

    expect(
      estimateTimelineRowHeight({
        kind: "work",
        groupedEntries: overflowEntries,
      }),
    ).toBe(254);
  });

  it("includes all work entries once an overflow work group is expanded", () => {
    const overflowEntries = Array.from({ length: 8 }, (_, index) => ({
      label: `Overflow step ${index + 1}`,
      tone: "tool" as const,
    }));

    expect(
      estimateTimelineRowHeight({
        kind: "work",
        groupedEntries: overflowEntries,
        expanded: true,
      }),
    ).toBe(318);
  });

  it("adds chip rows for changed-file work entries that also show command or detail", () => {
    expect(
      estimateTimelineRowHeight({
        kind: "work",
        groupedEntries: [
          {
            label: "Updated changed files",
            tone: "tool",
            command: "apply_patch",
            changedFiles: [
              "apps/web/src/components/chat/MessagesTimeline.tsx",
              "apps/web/src/components/timelineHeight.ts",
              "apps/web/src/components/timelineHeight.test.ts",
              "apps/web/src/components/chat/MessagesTimeline.browser.tsx",
              "apps/web/src/components/ChatView.browser.helpers.tsx",
            ],
          },
        ],
      }),
    ).toBe(134);
  });

  it("uses the full displayed markdown for short proposed plans", () => {
    const shortPlanBaseline = estimateTimelineRowHeight({
      kind: "proposed-plan",
      proposedPlan: {
        planMarkdown: "# Plan\n\n- Short step one",
      },
    });
    const shortPlanExpandedBody = estimateTimelineRowHeight({
      kind: "proposed-plan",
      proposedPlan: {
        planMarkdown: [
          "# Plan",
          "",
          "- Short step one",
          "- Short step two",
          "- Short step three",
          "- Short step four",
          "- Short step five",
          "- Short step six",
        ].join("\n"),
      },
    });

    expect(shortPlanExpandedBody).toBeGreaterThan(shortPlanBaseline);
  });

  it("uses collapsed preview logic for long proposed plans", () => {
    const previewLines = Array.from({ length: 10 }, (_, index) => `- Preview line ${index + 1}`);
    const longPlanWithoutTail = estimateTimelineRowHeight({
      kind: "proposed-plan",
      proposedPlan: {
        planMarkdown: [
          "# Plan",
          "",
          ...previewLines,
          "",
          "- tail filler 1",
          "- tail filler 2",
          "- tail filler 3",
          "- tail filler 4",
          "- tail filler 5",
          "- tail filler 6",
          "- tail filler 7",
          "- tail filler 8",
          "- tail filler 9",
          "- tail filler 10",
          "- tail filler 11",
        ].join("\n"),
      },
    });
    const longPlanWithExtraTail = estimateTimelineRowHeight({
      kind: "proposed-plan",
      proposedPlan: {
        planMarkdown: [
          "# Plan",
          "",
          ...previewLines,
          "",
          ...Array.from({ length: 30 }, (_, index) => `- Hidden detail ${index + 1}`),
        ].join("\n"),
      },
    });

    expect(longPlanWithExtraTail).toBe(longPlanWithoutTail);
  });

  it("caps long collapsed proposed-plan preview height", () => {
    expect(
      estimateTimelineRowHeight({
        kind: "proposed-plan",
        proposedPlan: {
          planMarkdown: ["# Plan", "", ...Array.from({ length: 24 }, () => "x".repeat(500))].join(
            "\n",
          ),
        },
      }),
    ).toBe(562);
  });

  it("keeps the working row fixed", () => {
    expect(estimateTimelineRowHeight({ kind: "working" })).toBe(40);
  });

  it("covers generated thread-ready rows across messages, work groups, and proposed plans", () => {
    for (const generatedCase of generateTimelineHeightThreadCases()) {
      const collapsedRows = buildGeneratedTimelineHeightRows(generatedCase);
      const expandedRows = buildGeneratedTimelineHeightRows(generatedCase, {
        expandedWorkGroupIds: [generatedCase.ids.workGroup],
      });

      const userRow = getGeneratedMessageRow(collapsedRows, generatedCase.ids.user);
      const assistantBaselineRow = getGeneratedMessageRow(
        collapsedRows,
        generatedCase.ids.assistantBaseline,
      );
      const assistantMarkdownBaselineRow = getGeneratedMessageRow(
        collapsedRows,
        generatedCase.ids.assistantMarkdownBaseline,
      );
      const assistantStructuredRow = getGeneratedMessageRow(
        collapsedRows,
        generatedCase.ids.assistantStructured,
      );
      const assistantCompletionRow = getGeneratedMessageRow(
        collapsedRows,
        generatedCase.ids.assistantCompletion,
      );
      const assistantDiffSummaryRow = getGeneratedMessageRow(
        collapsedRows,
        generatedCase.ids.assistantDiffSummary,
      );
      const systemRow = getGeneratedMessageRow(collapsedRows, generatedCase.ids.system);
      const collapsedWorkRow = getGeneratedWorkRow(collapsedRows, generatedCase.ids.workGroup);
      const expandedWorkRow = getGeneratedWorkRow(expandedRows, generatedCase.ids.workGroup);
      const shortPlanRow = getGeneratedPlanRow(collapsedRows, generatedCase.ids.shortPlan);
      const longPlanRow = getGeneratedPlanRow(collapsedRows, generatedCase.ids.longPlan);
      const longerPlanRow = getGeneratedPlanRow(collapsedRows, generatedCase.ids.longerPlan);
      const workingRow = getGeneratedRow(collapsedRows, generatedCase.ids.working);

      expect(
        countLines(userRow.message.text),
        `user thread case ${generatedCase.index} should keep long-form randomized content`,
      ).toBeGreaterThanOrEqual(4);
      expect(
        countLines(userRow.message.text),
        `user thread case ${generatedCase.index} should keep long-form randomized content`,
      ).toBeLessThanOrEqual(50);
      expect(
        countLines(assistantBaselineRow.message.text),
        `assistant thread case ${generatedCase.index} should keep long-form randomized content`,
      ).toBeGreaterThanOrEqual(4);
      expect(
        countLines(assistantBaselineRow.message.text),
        `assistant thread case ${generatedCase.index} should keep long-form randomized content`,
      ).toBeLessThanOrEqual(50);
      expect(
        countLines(assistantMarkdownBaselineRow.message.text),
        `markdown baseline case ${generatedCase.index} should keep long-form randomized content`,
      ).toBeGreaterThanOrEqual(4);
      expect(
        countLines(assistantMarkdownBaselineRow.message.text),
        `markdown baseline case ${generatedCase.index} should keep long-form randomized content`,
      ).toBeLessThanOrEqual(50);
      expect(
        countLines(assistantStructuredRow.message.text),
        `structured markdown case ${generatedCase.index} should keep long-form randomized content`,
      ).toBeGreaterThanOrEqual(4);
      expect(
        countLines(assistantStructuredRow.message.text),
        `structured markdown case ${generatedCase.index} should keep long-form randomized content`,
      ).toBeLessThanOrEqual(50);

      expect(
        estimateTimelineRowHeight(userRow),
        `row message case ${generatedCase.index} should delegate user rows to message estimation`,
      ).toBe(estimateTimelineMessageHeight(userRow.message));
      expect(
        estimateTimelineRowHeight(systemRow),
        `system row case ${generatedCase.index} should stay on the assistant sizing path`,
      ).toBe(estimateTimelineRowHeight(assistantBaselineRow));

      const assistantBaselineHeight = estimateTimelineRowHeight(assistantBaselineRow);
      const assistantMarkdownBaselineHeight = estimateTimelineRowHeight(
        assistantMarkdownBaselineRow,
      );
      const assistantStructuredHeight = estimateTimelineRowHeight(assistantStructuredRow);
      const assistantCompletionHeight = estimateTimelineRowHeight(assistantCompletionRow);
      const assistantDiffSummaryHeight = estimateTimelineRowHeight(assistantDiffSummaryRow);

      expect(
        assistantStructuredHeight,
        `assistant row case ${generatedCase.index} structured markdown should not be shorter than the same body as plain text`,
      ).toBeGreaterThanOrEqual(assistantMarkdownBaselineHeight);
      expect(
        assistantCompletionHeight - assistantBaselineHeight,
        `assistant row case ${generatedCase.index} completion divider delta`,
      ).toBe(48);
      expect(
        assistantDiffSummaryHeight,
        `assistant row case ${generatedCase.index} diff summary should increase height`,
      ).toBeGreaterThan(assistantBaselineHeight);

      const collapsedWorkHeight = estimateTimelineRowHeight(collapsedWorkRow);
      const expandedWorkHeight = estimateTimelineRowHeight(expandedWorkRow);

      expect(
        expandedWorkHeight,
        `work row case ${generatedCase.index} expanded height should not be smaller than collapsed`,
      ).toBeGreaterThanOrEqual(collapsedWorkHeight);

      const shortPlanHeight = estimateTimelineRowHeight(shortPlanRow);
      const longPlanHeight = estimateTimelineRowHeight(longPlanRow);
      const longerPlanHeight = estimateTimelineRowHeight(longerPlanRow);

      expect(
        shortPlanHeight,
        `plan case ${generatedCase.index} short plan should exceed the chrome-only baseline`,
      ).toBeGreaterThan(110);
      expect(
        longerPlanHeight,
        `plan case ${generatedCase.index} adding hidden tail content should keep the collapsed preview stable`,
      ).toBe(longPlanHeight);
      expect(
        estimateTimelineRowHeight(workingRow),
        `working row case ${generatedCase.index} should stay fixed`,
      ).toBe(40);
    }
  });

  it("covers named edge fixtures for tables, code, fallback attachments, streaming, and plans", () => {
    const edgeCases = generateTimelineHeightEdgeCases();

    const denseTableCase = edgeCases.find((candidate) => candidate.name === "dense-table-markdown");
    const longFencedCodeCase = edgeCases.find((candidate) => candidate.name === "long-fenced-code");
    const deepDiffTreeCase = edgeCases.find((candidate) => candidate.name === "deep-diff-tree");
    const borderlinePlanCase = edgeCases.find(
      (candidate) => candidate.name === "borderline-collapsible-plan",
    );
    const attachmentFallbackCase = edgeCases.find(
      (candidate) => candidate.name === "attachment-fallback",
    );
    const streamingCase = edgeCases.find((candidate) => candidate.name === "streaming-messages");

    expect(denseTableCase).toBeDefined();
    expect(longFencedCodeCase).toBeDefined();
    expect(deepDiffTreeCase).toBeDefined();
    expect(borderlinePlanCase).toBeDefined();
    expect(attachmentFallbackCase).toBeDefined();
    expect(streamingCase).toBeDefined();

    const denseTableRows = buildGeneratedTimelineHeightRows(denseTableCase!.generatedCase);
    const denseStructuredRow = getGeneratedMessageRow(
      denseTableRows,
      denseTableCase!.generatedCase.ids.assistantStructured,
    );
    expect(denseStructuredRow.message.text).toContain("| file | additions | deletions | status |");
    expect(estimateTimelineRowHeight(denseStructuredRow)).toBeGreaterThan(300);

    const fencedCodeRows = buildGeneratedTimelineHeightRows(longFencedCodeCase!.generatedCase);
    const fencedStructuredRow = getGeneratedMessageRow(
      fencedCodeRows,
      longFencedCodeCase!.generatedCase.ids.assistantStructured,
    );
    expect(fencedStructuredRow.message.text).toContain("```ts");
    expect(estimateTimelineRowHeight(fencedStructuredRow)).toBeGreaterThan(300);

    const deepDiffRows = buildGeneratedTimelineHeightRows(deepDiffTreeCase!.generatedCase);
    const deepDiffRow = getGeneratedMessageRow(
      deepDiffRows,
      deepDiffTreeCase!.generatedCase.ids.assistantDiffSummary,
    );
    expect(deepDiffRow.diffSummary?.files.length).toBeGreaterThanOrEqual(18);
    expect(estimateTimelineRowHeight(deepDiffRow)).toBeGreaterThan(
      estimateTimelineRowHeight({
        kind: "message",
        message: {
          role: "assistant",
          text: deepDiffRow.message.text,
        },
      }),
    );

    const borderlinePlanRows = buildGeneratedTimelineHeightRows(borderlinePlanCase!.generatedCase);
    const borderlinePlanRow = getGeneratedPlanRow(
      borderlinePlanRows,
      borderlinePlanCase!.generatedCase.ids.longPlan,
    );
    expect(borderlinePlanRow.proposedPlan.planMarkdown.split("\n").length).toBe(22);
    expect(estimateTimelineRowHeight(borderlinePlanRow)).toBeGreaterThan(200);

    const attachmentFallbackRows = buildGeneratedTimelineHeightRows(
      attachmentFallbackCase!.generatedCase,
    );
    const attachmentFallbackUserRow = getGeneratedMessageRow(
      attachmentFallbackRows,
      attachmentFallbackCase!.generatedCase.ids.user,
    );
    const attachmentFallbackUserEntry =
      attachmentFallbackCase!.generatedCase.thread.timelineEntries.find(
        (entry) => entry.id === attachmentFallbackCase!.generatedCase.ids.user,
      );
    expect(
      attachmentFallbackUserEntry?.kind === "message" &&
        attachmentFallbackUserEntry.message.attachments?.every(
          (attachment) => !attachment.previewUrl,
        ),
    ).toBe(true);
    expect(estimateTimelineRowHeight(attachmentFallbackUserRow)).toBeGreaterThan(300);

    const streamingRows = buildGeneratedTimelineHeightRows(streamingCase!.generatedCase);
    const streamingSystemRow = getGeneratedMessageRow(
      streamingRows,
      streamingCase!.generatedCase.ids.system,
    );
    const streamingAssistantEntry = streamingCase!.generatedCase.thread.timelineEntries.find(
      (entry) => entry.id === streamingCase!.generatedCase.ids.assistantBaseline,
    );
    const streamingSystemEntry = streamingCase!.generatedCase.thread.timelineEntries.find(
      (entry) => entry.id === streamingCase!.generatedCase.ids.system,
    );
    expect(
      streamingAssistantEntry?.kind === "message" && streamingAssistantEntry.message.streaming,
    ).toBe(true);
    expect(streamingSystemEntry?.kind === "message" && streamingSystemEntry.message.streaming).toBe(
      true,
    );
    expect(estimateTimelineRowHeight(streamingSystemRow)).toBe(
      estimateTimelineRowHeight({
        kind: "message",
        message: {
          role: "assistant",
          text: streamingSystemRow.message.text,
        },
      }),
    );
  });
});
