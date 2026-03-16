import type { MessageId, OrchestrationProposedPlanId, TurnId } from "@t3tools/contracts";

import type { TimelineEntry, WorkLogEntry } from "../session-logic";
import type { ChatAttachment, ChatMessage, ProposedPlan, TurnDiffSummary } from "../types";
import { resolveMessagesTimelineRows } from "./chat/MessagesTimeline.logic";
import type { TimelineRowHeightInput } from "./timelineHeight";

const GENERATED_MIN_LINES = 4;
const GENERATED_MAX_LINES = 50;
const ATTACHMENT_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='300'></svg>";

export interface GeneratedTimelineHeightThreadCase {
  index: number;
  ids: {
    user: string;
    assistantBaseline: string;
    assistantMarkdownBaseline: string;
    assistantStructured: string;
    assistantCompletion: string;
    assistantDiffSummary: string;
    system: string;
    workGroup: string;
    shortPlan: string;
    longPlan: string;
    longerPlan: string;
    working: string;
  };
  thread: {
    timelineEntries: TimelineEntry[];
    completionDividerBeforeEntryId: string | null;
    turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
    isWorking: boolean;
  };
}

export interface GeneratedTimelineHeightResolvedRow {
  id: string;
  input: TimelineRowHeightInput;
}

export interface GeneratedTimelineHeightEdgeCase {
  name:
    | "dense-table-markdown"
    | "long-fenced-code"
    | "deep-diff-tree"
    | "borderline-collapsible-plan"
    | "attachment-fallback"
    | "streaming-messages";
  generatedCase: GeneratedTimelineHeightThreadCase;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let next = Math.imul(state ^ (state >>> 15), 1 | state);
    next ^= next + Math.imul(next ^ (next >>> 7), 61 | next);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(random: () => number, min: number, max: number): number {
  return Math.floor(random() * (max - min + 1)) + min;
}

function randomWord(random: () => number, minLength = 1, maxLength = 18): string {
  const length = randomInt(random, minLength, maxLength);
  return Array.from({ length }, () =>
    String.fromCharCode("a".charCodeAt(0) + randomInt(random, 0, 25)),
  ).join("");
}

function randomLine(random: () => number, minWords = 2, maxWords = 14): string {
  return Array.from({ length: randomInt(random, minWords, maxWords) }, () =>
    randomWord(random),
  ).join(" ");
}

function randomPlainTextByLineCount(
  random: () => number,
  minLines = GENERATED_MIN_LINES,
  maxLines = GENERATED_MAX_LINES,
): string {
  const lineCount = randomInt(random, minLines, maxLines);
  return Array.from({ length: lineCount }, () => {
    const wordCount = randomInt(random, 2, 18);
    return Array.from({ length: wordCount }, () => randomWord(random)).join(" ");
  }).join("\n");
}

function randomMarkdownTextByLineCount(
  random: () => number,
  minLines = GENERATED_MIN_LINES,
  maxLines = GENERATED_MAX_LINES,
): string {
  const lineBudget = randomInt(random, minLines, maxLines);
  const lines = [
    `# ${randomLine(random, 2, 6)}`,
    "",
    randomLine(random, 8, 18),
    `- ${randomLine(random, 4, 10)}`,
    `- ${randomLine(random, 4, 10)}`,
    `1. ${randomLine(random, 4, 10)}`,
    `> ${randomLine(random, 5, 12)}`,
    "| file | additions | deletions |",
    "| --- | ---: | ---: |",
    `| ${randomWord(random, 5, 12)}.ts | ${randomInt(random, 1, 99)} | ${randomInt(random, 0, 40)} |`,
    "```ts",
    `export const ${randomWord(random, 4, 10)} = "${randomWord(random, 12, 24)}";`,
    "```",
  ];

  while (lines.length < lineBudget) {
    const insertionIndex = Math.max(2, lines.length - 3);
    lines.splice(insertionIndex, 0, randomLine(random, 6, 18));
  }

  return lines.slice(0, lineBudget).join("\n");
}

function randomChangedFiles(random: () => number, count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const segments = Array.from({ length: randomInt(random, 1, 4) }, () =>
      randomWord(random, 3, 12),
    );
    return `apps/${segments.join("/")}/${randomWord(random, 4, 12)}-${index + 1}.ts`;
  });
}

function asMessageId(value: string): MessageId {
  return value as MessageId;
}

function asTurnId(value: string): TurnId {
  return value as TurnId;
}

function asProposedPlanId(value: string): OrchestrationProposedPlanId {
  return value as OrchestrationProposedPlanId;
}

export function makeTimelineHeightAttachments(count: number): ChatAttachment[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "image",
    id: `attachment-${index + 1}`,
    name: `attachment-${index + 1}.png`,
    mimeType: "image/png",
    sizeBytes: (index + 1) * 1_024,
    previewUrl: `data:image/svg+xml;utf8,${encodeURIComponent(ATTACHMENT_SVG)}`,
  }));
}

function createTimestamp(caseIndex: number, offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 2, 16, 12, caseIndex, offsetSeconds)).toISOString();
}

function createMessage(input: {
  id: string;
  role: ChatMessage["role"];
  text: string;
  createdAt: string;
  attachments?: ChatAttachment[];
}): ChatMessage {
  return {
    id: asMessageId(input.id),
    role: input.role,
    text: input.text,
    createdAt: input.createdAt,
    streaming: false,
    ...(input.attachments ? { attachments: input.attachments } : {}),
  };
}

function createProposedPlan(input: {
  id: string;
  createdAt: string;
  planMarkdown: string;
}): ProposedPlan {
  return {
    id: asProposedPlanId(input.id),
    turnId: asTurnId(`${input.id}-turn`),
    planMarkdown: input.planMarkdown,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

function createWorkEntry(
  random: () => number,
  caseIndex: number,
  entryIndex: number,
): WorkLogEntry {
  const id = `case-${caseIndex}-work-entry-${entryIndex + 1}`;
  const createdAt = createTimestamp(caseIndex, 8 + entryIndex);
  const label = randomLine(random, 3, 10);
  const changedFiles = randomChangedFiles(random, randomInt(random, 1, 7));

  if (entryIndex === 0) {
    return {
      id,
      createdAt,
      label,
      tone: "thinking",
      detail: randomLine(random, 5, 14),
    };
  }
  if (entryIndex === 1) {
    return {
      id,
      createdAt,
      label,
      tone: "tool",
      command: `tool-${randomWord(random, 4, 10)}`,
      changedFiles,
    };
  }
  if (entryIndex === 2) {
    return {
      id,
      createdAt,
      label,
      tone: "tool",
      changedFiles,
    };
  }
  if (entryIndex === 3) {
    return {
      id,
      createdAt,
      label,
      tone: "info",
      detail: randomLine(random, 5, 14),
    };
  }
  if (entryIndex === 4) {
    return {
      id,
      createdAt,
      label,
      tone: "error",
      detail: randomLine(random, 5, 14),
    };
  }

  return {
    id,
    createdAt,
    label,
    tone: (["thinking", "tool", "info", "error"] as const)[entryIndex % 4]!,
    ...(random() < 0.5 ? { command: `cmd-${randomWord(random, 4, 10)}` } : {}),
    ...(random() < 0.5 ? { detail: randomLine(random, 5, 14) } : {}),
    ...(random() < 0.75 ? { changedFiles } : {}),
  };
}

export function generateTimelineHeightThreadCases(
  count = 100,
): GeneratedTimelineHeightThreadCase[] {
  const random = createSeededRandom(0x5eed1234);

  return Array.from({ length: count }, (_, index) => {
    const userText = randomPlainTextByLineCount(random);
    const assistantText = randomPlainTextByLineCount(random);
    const markdownBody = randomPlainTextByLineCount(random, 4, 39);
    const markdownSummary = markdownBody.replace(/\s+/g, " ").trim();
    const markdownText = [
      `# ${markdownSummary.slice(0, 48) || "heading"}`,
      "",
      markdownBody,
      "",
      `- ${markdownSummary.slice(0, 32) || "first item"}`,
      `- ${markdownSummary.slice(32, 64) || "second item"}`,
      "",
      `> ${markdownSummary.slice(0, 72) || "quoted note"}`,
      "",
      "```ts",
      `export const sampleValue = "${markdownSummary.slice(0, 24) || "value"}";`,
      "```",
    ].join("\n");
    const attachmentCount = randomInt(random, 0, 4);
    const diffSummaryFiles = randomChangedFiles(random, randomInt(random, 1, 12)).map((path) => ({
      path,
      additions: randomInt(random, 0, 120),
      deletions: randomInt(random, 0, 80),
    }));
    const workEntries = Array.from({ length: randomInt(random, 7, 14) }, (_, entryIndex) =>
      createWorkEntry(random, index, entryIndex),
    );

    const shortPlanMarkdown = randomMarkdownTextByLineCount(random, 4, 18);
    const previewPlanMarkdown = [
      "# Plan",
      "",
      ...Array.from({ length: 10 }, () => `- ${randomLine(random, 6, 18)}`),
    ].join("\n");
    const longPlanMarkdown = [
      previewPlanMarkdown,
      "",
      ...Array.from({ length: randomInt(random, 12, 24) }, () => `- ${randomLine(random, 8, 20)}`),
    ].join("\n");
    const longerPlanMarkdown = [
      longPlanMarkdown,
      "",
      ...Array.from({ length: randomInt(random, 4, 10) }, () => `- ${randomLine(random, 8, 20)}`),
    ].join("\n");

    const ids = {
      user: `case-${index}-user`,
      assistantBaseline: `case-${index}-assistant-baseline`,
      assistantMarkdownBaseline: `case-${index}-assistant-markdown-baseline`,
      assistantStructured: `case-${index}-assistant-structured`,
      assistantCompletion: `case-${index}-assistant-completion`,
      assistantDiffSummary: `case-${index}-assistant-diff-summary`,
      system: `case-${index}-system`,
      workGroup: `case-${index}-work-group`,
      shortPlan: `case-${index}-short-plan`,
      longPlan: `case-${index}-long-plan`,
      longerPlan: `case-${index}-longer-plan`,
      working: "working-indicator-row",
    };

    const userMessage = createMessage({
      id: `${ids.user}-message`,
      role: "user",
      text: userText,
      attachments: makeTimelineHeightAttachments(attachmentCount),
      createdAt: createTimestamp(index, 1),
    });
    const assistantBaselineMessage = createMessage({
      id: `${ids.assistantBaseline}-message`,
      role: "assistant",
      text: assistantText,
      createdAt: createTimestamp(index, 2),
    });
    const assistantMarkdownBaselineMessage = createMessage({
      id: `${ids.assistantMarkdownBaseline}-message`,
      role: "assistant",
      text: markdownBody,
      createdAt: createTimestamp(index, 3),
    });
    const assistantStructuredMessage = createMessage({
      id: `${ids.assistantStructured}-message`,
      role: "assistant",
      text: markdownText,
      createdAt: createTimestamp(index, 4),
    });
    const assistantCompletionMessage = createMessage({
      id: `${ids.assistantCompletion}-message`,
      role: "assistant",
      text: assistantText,
      createdAt: createTimestamp(index, 5),
    });
    const assistantDiffSummaryMessage = createMessage({
      id: `${ids.assistantDiffSummary}-message`,
      role: "assistant",
      text: assistantText,
      createdAt: createTimestamp(index, 6),
    });
    const systemMessage = createMessage({
      id: `${ids.system}-message`,
      role: "system",
      text: assistantText,
      createdAt: createTimestamp(index, 7),
    });

    return {
      index,
      ids,
      thread: {
        timelineEntries: [
          {
            id: ids.user,
            kind: "message",
            createdAt: userMessage.createdAt,
            message: userMessage,
          },
          {
            id: ids.assistantBaseline,
            kind: "message",
            createdAt: assistantBaselineMessage.createdAt,
            message: assistantBaselineMessage,
          },
          {
            id: ids.assistantMarkdownBaseline,
            kind: "message",
            createdAt: assistantMarkdownBaselineMessage.createdAt,
            message: assistantMarkdownBaselineMessage,
          },
          {
            id: ids.assistantStructured,
            kind: "message",
            createdAt: assistantStructuredMessage.createdAt,
            message: assistantStructuredMessage,
          },
          {
            id: ids.assistantCompletion,
            kind: "message",
            createdAt: assistantCompletionMessage.createdAt,
            message: assistantCompletionMessage,
          },
          {
            id: ids.assistantDiffSummary,
            kind: "message",
            createdAt: assistantDiffSummaryMessage.createdAt,
            message: assistantDiffSummaryMessage,
          },
          {
            id: ids.system,
            kind: "message",
            createdAt: systemMessage.createdAt,
            message: systemMessage,
          },
          ...workEntries.map((entry, entryIndex) => ({
            id: entryIndex === 0 ? ids.workGroup : `case-${index}-work-${entryIndex + 1}`,
            kind: "work" as const,
            createdAt: entry.createdAt,
            entry,
          })),
          {
            id: ids.shortPlan,
            kind: "proposed-plan",
            createdAt: createTimestamp(index, 30),
            proposedPlan: createProposedPlan({
              id: `${ids.shortPlan}-plan`,
              createdAt: createTimestamp(index, 30),
              planMarkdown: shortPlanMarkdown,
            }),
          },
          {
            id: ids.longPlan,
            kind: "proposed-plan",
            createdAt: createTimestamp(index, 31),
            proposedPlan: createProposedPlan({
              id: `${ids.longPlan}-plan`,
              createdAt: createTimestamp(index, 31),
              planMarkdown: longPlanMarkdown,
            }),
          },
          {
            id: ids.longerPlan,
            kind: "proposed-plan",
            createdAt: createTimestamp(index, 32),
            proposedPlan: createProposedPlan({
              id: `${ids.longerPlan}-plan`,
              createdAt: createTimestamp(index, 32),
              planMarkdown: longerPlanMarkdown,
            }),
          },
        ],
        completionDividerBeforeEntryId: ids.assistantCompletion,
        turnDiffSummaryByAssistantMessageId: new Map([
          [
            assistantDiffSummaryMessage.id,
            {
              turnId: asTurnId(`case-${index}-turn`),
              completedAt: assistantDiffSummaryMessage.createdAt,
              files: diffSummaryFiles,
              assistantMessageId: assistantDiffSummaryMessage.id,
            },
          ],
        ]),
        isWorking: true,
      },
    };
  });
}

export function buildGeneratedTimelineHeightRows(
  generatedCase: GeneratedTimelineHeightThreadCase,
  options: { expandedWorkGroupIds?: ReadonlyArray<string> } = {},
): GeneratedTimelineHeightResolvedRow[] {
  const expandedWorkGroupIds = new Set(options.expandedWorkGroupIds ?? []);
  return resolveMessagesTimelineRows({
    timelineEntries: generatedCase.thread.timelineEntries,
    completionDividerBeforeEntryId: generatedCase.thread.completionDividerBeforeEntryId,
    turnDiffSummaryByAssistantMessageId: generatedCase.thread.turnDiffSummaryByAssistantMessageId,
    isWorking: generatedCase.thread.isWorking,
    activeTurnStartedAt: generatedCase.thread.isWorking
      ? (generatedCase.thread.timelineEntries.at(-1)?.createdAt ?? null)
      : null,
  }).map((row) => {
    if (row.kind === "work") {
      return {
        id: row.id,
        input: {
          kind: "work",
          groupedEntries: row.groupedEntries,
          expanded: expandedWorkGroupIds.has(row.id),
        },
      };
    }
    if (row.kind === "proposed-plan") {
      return {
        id: row.id,
        input: {
          kind: "proposed-plan",
          proposedPlan: row.proposedPlan,
        },
      };
    }
    if (row.kind === "working") {
      return {
        id: row.id,
        input: { kind: "working" },
      };
    }
    return {
      id: row.id,
      input: {
        kind: "message",
        message: row.message,
        showCompletionDivider: row.showCompletionDivider,
        diffSummary: row.assistantDiffSummary ? { files: row.assistantDiffSummary.files } : null,
      },
    };
  });
}

function findTimelineEntryById(
  generatedCase: GeneratedTimelineHeightThreadCase,
  id: string,
): TimelineEntry {
  const entry = generatedCase.thread.timelineEntries.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`Unable to locate generated timeline entry ${id}`);
  }
  return entry;
}

function findMessageEntryById(
  generatedCase: GeneratedTimelineHeightThreadCase,
  id: string,
): Extract<TimelineEntry, { kind: "message" }> {
  const entry = findTimelineEntryById(generatedCase, id);
  if (entry.kind !== "message") {
    throw new Error(`Generated timeline entry ${id} is not a message`);
  }
  return entry;
}

function findPlanEntryById(
  generatedCase: GeneratedTimelineHeightThreadCase,
  id: string,
): Extract<TimelineEntry, { kind: "proposed-plan" }> {
  const entry = findTimelineEntryById(generatedCase, id);
  if (entry.kind !== "proposed-plan") {
    throw new Error(`Generated timeline entry ${id} is not a proposed plan`);
  }
  return entry;
}

function findDiffSummary(
  generatedCase: GeneratedTimelineHeightThreadCase,
  assistantMessageId: MessageId,
): TurnDiffSummary {
  const summary = generatedCase.thread.turnDiffSummaryByAssistantMessageId.get(assistantMessageId);
  if (!summary) {
    throw new Error(`Unable to locate generated diff summary for ${assistantMessageId}`);
  }
  return summary;
}

export function generateTimelineHeightEdgeCases(): GeneratedTimelineHeightEdgeCase[] {
  const baseCases = generateTimelineHeightThreadCases(6);

  const denseTableCase = baseCases[0]!;
  findMessageEntryById(denseTableCase, denseTableCase.ids.assistantStructured).message.text = [
    "# Changed files overview",
    "",
    "| file | additions | deletions | status |",
    "| --- | ---: | ---: | --- |",
    ...Array.from({ length: 18 }, (_, index) => {
      const suffix = index + 1;
      return `| apps/web/src/components/section-${suffix}.tsx | ${suffix * 3} | ${suffix} | updated |`;
    }),
  ].join("\n");

  const longFencedCodeCase = baseCases[1]!;
  findMessageEntryById(
    longFencedCodeCase,
    longFencedCodeCase.ids.assistantStructured,
  ).message.text = [
    "```ts",
    ...Array.from(
      { length: 28 },
      (_, index) =>
        `export const line${index + 1} = "stream-${index + 1}-${"x".repeat(16 + (index % 8))}";`,
    ),
    "```",
  ].join("\n");

  const deepDiffTreeCase = baseCases[2]!;
  const deepDiffSummary = findDiffSummary(
    deepDiffTreeCase,
    findMessageEntryById(deepDiffTreeCase, deepDiffTreeCase.ids.assistantDiffSummary).message.id,
  );
  deepDiffSummary.files = Array.from({ length: 18 }, (_, index) => ({
    path: `apps/web/src/features/deep/tree/level-${(index % 6) + 1}/branch-${index + 1}/file-${index + 1}.ts`,
    additions: 4 + index,
    deletions: index % 5,
  }));

  const borderlinePlanCase = baseCases[3]!;
  findPlanEntryById(borderlinePlanCase, borderlinePlanCase.ids.longPlan).proposedPlan.planMarkdown =
    [
      "# Borderline collapsible plan",
      "",
      ...Array.from({ length: 20 }, (_, index) => `- Step ${index + 1}: ${"detail ".repeat(8)}`),
    ].join("\n");

  const attachmentFallbackCase = baseCases[4]!;
  const fallbackUserEntry = findMessageEntryById(
    attachmentFallbackCase,
    attachmentFallbackCase.ids.user,
  );
  for (const attachment of fallbackUserEntry.message.attachments ?? []) {
    delete attachment.previewUrl;
  }

  const streamingMessagesCase = baseCases[5]!;
  const streamingAssistantEntry = findMessageEntryById(
    streamingMessagesCase,
    streamingMessagesCase.ids.assistantBaseline,
  );
  streamingAssistantEntry.message.streaming = true;
  streamingAssistantEntry.message.completedAt = undefined;
  const streamingSystemEntry = findMessageEntryById(
    streamingMessagesCase,
    streamingMessagesCase.ids.system,
  );
  streamingSystemEntry.message.streaming = true;
  streamingSystemEntry.message.completedAt = undefined;

  return [
    { name: "dense-table-markdown", generatedCase: denseTableCase },
    { name: "long-fenced-code", generatedCase: longFencedCodeCase },
    { name: "deep-diff-tree", generatedCase: deepDiffTreeCase },
    { name: "borderline-collapsible-plan", generatedCase: borderlinePlanCase },
    { name: "attachment-fallback", generatedCase: attachmentFallbackCase },
    { name: "streaming-messages", generatedCase: streamingMessagesCase },
  ];
}
