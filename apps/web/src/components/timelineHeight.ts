const ASSISTANT_CHARS_PER_LINE_FALLBACK = 72;
const USER_CHARS_PER_LINE_FALLBACK = 56;
const LINE_HEIGHT_PX = 22;
const ASSISTANT_BASE_HEIGHT_PX = 78;
const USER_BASE_HEIGHT_PX = 73;
const ATTACHMENTS_PER_ROW = 2;
// Attachment thumbnails render with `max-h-[220px]` plus ~8px row gap.
const USER_ATTACHMENT_ROW_HEIGHT_PX = 228;
const USER_BUBBLE_WIDTH_RATIO = 0.8;
const USER_BUBBLE_HORIZONTAL_PADDING_PX = 32;
const ASSISTANT_MESSAGE_HORIZONTAL_PADDING_PX = 8;
const USER_MONO_AVG_CHAR_WIDTH_PX = 8.4;
const ASSISTANT_AVG_CHAR_WIDTH_PX = 7.2;
const MIN_USER_CHARS_PER_LINE = 4;
const MIN_ASSISTANT_CHARS_PER_LINE = 20;
const USER_LONG_WRAP_BIAS_THRESHOLD_LINES = 40;
const WORK_GROUP_ROW_BOTTOM_PADDING_PX = 16;
const WORK_GROUP_CARD_VERTICAL_PADDING_PX = 14;
const WORK_GROUP_HEADER_HEIGHT_PX = 20;
const WORK_GROUP_HEADER_TO_LIST_GAP_PX = 8;
const WORK_ENTRY_HEIGHT_PX = 28;
const WORK_ENTRY_STACK_GAP_PX = 2;
const WORK_ENTRY_CHANGED_FILES_TOP_MARGIN_PX = 4;
const WORK_ENTRY_CHANGED_FILES_ROW_HEIGHT_PX = 22;
const WORK_ENTRY_CHANGED_FILE_CHIP_WIDTH_PX = 168;
const WORK_ENTRY_CHANGED_FILES_MAX_VISIBLE = 4;
const WORK_ENTRY_CHANGED_FILES_WIDTH_PADDING_PX = 96;

interface TimelineMessageHeightInput {
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: ReadonlyArray<{ id: string }>;
}

interface TimelineHeightEstimateLayout {
  timelineWidthPx?: number | null;
}

interface TimelineWorkGroupHeightInput {
  tone: "thinking" | "tool" | "info" | "error";
  detail?: string;
  command?: string;
  changedFiles?: ReadonlyArray<string>;
}

interface TimelineWorkGroupEstimateLayout extends TimelineHeightEstimateLayout {
  expanded?: boolean;
  maxVisibleEntries?: number;
}

function estimateWrappedLineCount(text: string, charsPerLine: number): number {
  if (text.length === 0) return 1;

  // Avoid allocating via split for long logs; iterate once and count wrapped lines.
  let lines = 0;
  let currentLineLength = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lines += Math.max(1, Math.ceil(currentLineLength / charsPerLine));
      currentLineLength = 0;
      continue;
    }
    currentLineLength += 1;
  }

  lines += Math.max(1, Math.ceil(currentLineLength / charsPerLine));
  return lines;
}

function isFinitePositiveNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function estimateCharsPerLine(
  availableWidthPx: number | null,
  averageCharWidthPx: number,
  minimumCharsPerLine: number,
  fallbackCharsPerLine: number,
): number {
  if (!isFinitePositiveNumber(availableWidthPx)) return fallbackCharsPerLine;
  return Math.max(minimumCharsPerLine, Math.floor(availableWidthPx / averageCharWidthPx));
}

function estimateCharsPerLineForUser(timelineWidthPx: number | null): number {
  const bubbleWidthPx = isFinitePositiveNumber(timelineWidthPx)
    ? timelineWidthPx * USER_BUBBLE_WIDTH_RATIO
    : null;
  const textWidthPx =
    bubbleWidthPx === null ? null : Math.max(bubbleWidthPx - USER_BUBBLE_HORIZONTAL_PADDING_PX, 0);
  return estimateCharsPerLine(
    textWidthPx,
    USER_MONO_AVG_CHAR_WIDTH_PX,
    MIN_USER_CHARS_PER_LINE,
    USER_CHARS_PER_LINE_FALLBACK,
  );
}

function estimateCharsPerLineForAssistant(timelineWidthPx: number | null): number {
  const textWidthPx = isFinitePositiveNumber(timelineWidthPx)
    ? Math.max(timelineWidthPx - ASSISTANT_MESSAGE_HORIZONTAL_PADDING_PX, 0)
    : null;
  return estimateCharsPerLine(
    textWidthPx,
    ASSISTANT_AVG_CHAR_WIDTH_PX,
    MIN_ASSISTANT_CHARS_PER_LINE,
    ASSISTANT_CHARS_PER_LINE_FALLBACK,
  );
}

function estimateChangedFileChipRows(
  changedFileCount: number,
  timelineWidthPx: number | null,
): number {
  if (changedFileCount <= 0) return 0;
  const availableWidthPx = isFinitePositiveNumber(timelineWidthPx)
    ? Math.max(timelineWidthPx - WORK_ENTRY_CHANGED_FILES_WIDTH_PADDING_PX, 0)
    : WORK_ENTRY_CHANGED_FILE_CHIP_WIDTH_PX * 2;
  const chipsPerRow = Math.max(
    1,
    Math.floor(availableWidthPx / WORK_ENTRY_CHANGED_FILE_CHIP_WIDTH_PX),
  );
  return Math.ceil(Math.min(changedFileCount, WORK_ENTRY_CHANGED_FILES_MAX_VISIBLE) / chipsPerRow);
}

function estimateWorkEntryHeight(
  entry: TimelineWorkGroupHeightInput,
  timelineWidthPx: number | null,
): number {
  let height = WORK_ENTRY_HEIGHT_PX;
  const changedFileCount = entry.changedFiles?.length ?? 0;
  const previewIsChangedFiles = changedFileCount > 0 && !entry.command && !entry.detail;
  if (changedFileCount > 0 && !previewIsChangedFiles) {
    height +=
      WORK_ENTRY_CHANGED_FILES_TOP_MARGIN_PX +
      estimateChangedFileChipRows(changedFileCount, timelineWidthPx) *
        WORK_ENTRY_CHANGED_FILES_ROW_HEIGHT_PX;
  }
  return height;
}

export function estimateTimelineMessageHeight(
  message: TimelineMessageHeightInput,
  layout: TimelineHeightEstimateLayout = { timelineWidthPx: null },
): number {
  const timelineWidthPx = layout.timelineWidthPx ?? null;
  if (message.role === "assistant") {
    const charsPerLine = estimateCharsPerLineForAssistant(timelineWidthPx);
    const estimatedLines = estimateWrappedLineCount(message.text, charsPerLine);
    return ASSISTANT_BASE_HEIGHT_PX + estimatedLines * LINE_HEIGHT_PX;
  }

  if (message.role === "user") {
    const charsPerLine = estimateCharsPerLineForUser(timelineWidthPx);
    const estimatedLines = estimateWrappedLineCount(message.text, charsPerLine);
    const wrapBiasLines = estimatedLines >= USER_LONG_WRAP_BIAS_THRESHOLD_LINES ? 1 : 0;
    const attachmentCount = message.attachments?.length ?? 0;
    const attachmentRows = Math.ceil(attachmentCount / ATTACHMENTS_PER_ROW);
    const attachmentHeight = attachmentRows * USER_ATTACHMENT_ROW_HEIGHT_PX;
    return (
      USER_BASE_HEIGHT_PX + (estimatedLines + wrapBiasLines) * LINE_HEIGHT_PX + attachmentHeight
    );
  }

  // `system` messages are not rendered in the chat timeline, but keep a stable
  // explicit branch in case they are present in timeline data.
  const charsPerLine = estimateCharsPerLineForAssistant(timelineWidthPx);
  const estimatedLines = estimateWrappedLineCount(message.text, charsPerLine);
  return ASSISTANT_BASE_HEIGHT_PX + estimatedLines * LINE_HEIGHT_PX;
}

export function estimateTimelineWorkGroupHeight(
  groupedEntries: ReadonlyArray<TimelineWorkGroupHeightInput>,
  layout: TimelineWorkGroupEstimateLayout = { timelineWidthPx: null },
): number {
  const timelineWidthPx = layout.timelineWidthPx ?? null;
  if (groupedEntries.length === 0) {
    return WORK_GROUP_ROW_BOTTOM_PADDING_PX + WORK_GROUP_CARD_VERTICAL_PADDING_PX;
  }

  const maxVisibleEntries = layout.maxVisibleEntries ?? groupedEntries.length;
  const isExpanded = layout.expanded ?? false;
  const hasOverflow = groupedEntries.length > maxVisibleEntries;
  const visibleEntries =
    hasOverflow && !isExpanded ? groupedEntries.slice(-maxVisibleEntries) : groupedEntries;
  const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
  const showHeader = hasOverflow || !onlyToolEntries;
  const entryHeights = visibleEntries.reduce(
    (totalHeight, entry) => totalHeight + estimateWorkEntryHeight(entry, timelineWidthPx),
    0,
  );

  return (
    WORK_GROUP_ROW_BOTTOM_PADDING_PX +
    WORK_GROUP_CARD_VERTICAL_PADDING_PX +
    entryHeights +
    Math.max(visibleEntries.length - 1, 0) * WORK_ENTRY_STACK_GAP_PX +
    (showHeader ? WORK_GROUP_HEADER_HEIGHT_PX + WORK_GROUP_HEADER_TO_LIST_GAP_PX : 0)
  );
}
