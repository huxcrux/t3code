// Production CSS is part of the behavior under test because row height depends on it.
import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMemo, useState } from "react";
import { render } from "vitest-browser-react";

import { type TimestampFormat } from "../../appSettings";
import {
  buildGeneratedTimelineHeightRows,
  generateTimelineHeightEdgeCases,
  generateTimelineHeightThreadCases,
  type GeneratedTimelineHeightEdgeCase,
  type GeneratedTimelineHeightResolvedRow,
  type GeneratedTimelineHeightThreadCase,
} from "../timelineHeight.generated";
import { estimateTimelineRowHeight } from "../timelineHeight";
import { MessagesTimeline } from "./MessagesTimeline";

interface ViewportSpec {
  name: string;
  width: number;
  height: number;
}

const DESKTOP_VIEWPORT: ViewportSpec = { name: "desktop", width: 960, height: 1_100 };
const MOBILE_VIEWPORT: ViewportSpec = { name: "mobile", width: 430, height: 932 };
const DESKTOP_BROWSER_CASE_COUNT = 6;
const MOBILE_EDGE_CASE_NAMES: GeneratedTimelineHeightEdgeCase["name"][] = [
  "attachment-fallback",
  "streaming-messages",
];

function noop(): void {}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function waitForLayout(): Promise<void> {
  await nextFrame();
  await nextFrame();
}

async function waitForElement<T extends Element>(
  query: () => T | null,
  errorMessage: string,
): Promise<T> {
  let element: T | null = null;

  await vi.waitFor(
    () => {
      element = query();
      expect(element, errorMessage).toBeTruthy();
    },
    {
      timeout: 4_000,
      interval: 16,
    },
  );

  if (!element) {
    throw new Error(errorMessage);
  }

  return element;
}

async function waitForProductionStyles(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      ).not.toBe("");
    },
    {
      timeout: 4_000,
      interval: 16,
    },
  );
}

async function waitForImagesToLoad(scope: ParentNode): Promise<void> {
  const images = Array.from(scope.querySelectorAll("img"));
  if (images.length === 0) {
    return;
  }

  await Promise.all(
    images.map(
      (image) =>
        new Promise<void>((resolve) => {
          if (image.complete) {
            resolve();
            return;
          }
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        }),
    ),
  );
  await waitForLayout();
}

function rowTolerancePx(
  row: GeneratedTimelineHeightResolvedRow["input"],
  viewport: ViewportSpec,
  estimatedHeightPx: number,
): number {
  if (row.kind === "working") {
    return 8;
  }
  if (row.kind === "work") {
    return Math.max(viewport.name === "mobile" ? 128 : 112, Math.round(estimatedHeightPx * 0.14));
  }
  if (row.kind === "proposed-plan") {
    return Math.max(112, Math.round(estimatedHeightPx * 0.12));
  }
  if (row.message.role === "user") {
    const baseTolerancePx =
      viewport.name === "mobile" ? 136 : (row.message.attachments?.length ?? 0) > 0 ? 128 : 56;
    const proportionalTolerancePx = Math.round(
      estimatedHeightPx * (viewport.name === "mobile" ? 0.18 : 0.14),
    );
    return Math.max(baseTolerancePx, proportionalTolerancePx);
  }
  if (row.diffSummary) {
    return Math.max(
      viewport.name === "mobile" ? 128 : 96,
      Math.round(estimatedHeightPx * (viewport.name === "mobile" ? 0.42 : 0.14)),
    );
  }
  if (row.showCompletionDivider) {
    return Math.max(
      viewport.name === "mobile" ? 120 : 72,
      Math.round(estimatedHeightPx * (viewport.name === "mobile" ? 0.42 : 0.14)),
    );
  }
  return Math.max(
    viewport.name === "mobile" ? 168 : 56,
    Math.round(estimatedHeightPx * (viewport.name === "mobile" ? 0.22 : 0.14)),
  );
}

function GeneratedMessagesTimelineHarness(props: {
  generatedCase: GeneratedTimelineHeightThreadCase;
  expandedWorkGroupIds?: string[];
  activeTurnInProgress?: boolean;
}) {
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  const expandedWorkGroups = useMemo(
    () => Object.fromEntries((props.expandedWorkGroupIds ?? []).map((groupId) => [groupId, true])),
    [props.expandedWorkGroupIds],
  );
  const activeTurnStartedAt =
    props.generatedCase.thread.timelineEntries.find((entry) => entry.kind === "work")?.createdAt ??
    null;

  return (
    <div className="h-screen w-screen overflow-hidden bg-background text-foreground">
      <div
        ref={setScrollContainer}
        className="h-full overflow-y-auto overscroll-y-contain px-4 py-6"
      >
        <MessagesTimeline
          hasMessages={true}
          isWorking={props.generatedCase.thread.isWorking}
          activeTurnInProgress={props.activeTurnInProgress ?? false}
          activeTurnStartedAt={activeTurnStartedAt}
          scrollContainer={scrollContainer}
          timelineEntries={props.generatedCase.thread.timelineEntries}
          completionDividerBeforeEntryId={props.generatedCase.thread.completionDividerBeforeEntryId}
          completionSummary={null}
          turnDiffSummaryByAssistantMessageId={
            props.generatedCase.thread.turnDiffSummaryByAssistantMessageId
          }
          nowIso="2026-03-16T12:00:00.000Z"
          expandedWorkGroups={expandedWorkGroups}
          onToggleWorkGroup={noop}
          onOpenTurnDiff={noop}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={noop}
          isRevertingCheckpoint={false}
          onImageExpand={noop}
          markdownCwd={undefined}
          resolvedTheme="light"
          timestampFormat={"locale" satisfies TimestampFormat}
          workspaceRoot="/repo/project"
        />
      </div>
    </div>
  );
}

async function mountGeneratedTimeline(options: {
  generatedCase: GeneratedTimelineHeightThreadCase;
  expandedWorkGroupIds?: string[];
  activeTurnInProgress?: boolean;
  viewport: ViewportSpec;
}) {
  await page.viewport(options.viewport.width, options.viewport.height);
  await waitForProductionStyles();

  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.width = "100vw";
  host.style.height = "100vh";
  host.style.overflow = "hidden";
  document.body.append(host);

  const screen = await render(
    <GeneratedMessagesTimelineHarness
      generatedCase={options.generatedCase}
      {...(options.activeTurnInProgress ? { activeTurnInProgress: true } : {})}
      {...(options.expandedWorkGroupIds
        ? { expandedWorkGroupIds: options.expandedWorkGroupIds }
        : {})}
    />,
    { container: host },
  );

  await waitForLayout();

  const scrollContainer = host.querySelector<HTMLDivElement>(
    "div.overflow-y-auto.overscroll-y-contain",
  );
  if (!(scrollContainer instanceof HTMLDivElement)) {
    throw new Error("Unable to locate timeline scroll container.");
  }

  const timelineRoot = host.querySelector<HTMLElement>('[data-timeline-root="true"]');
  if (!(timelineRoot instanceof HTMLElement)) {
    throw new Error("Unable to locate timeline root.");
  }

  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
    host,
    scrollContainer,
    timelineRoot,
  };
}

function findRowElement(host: HTMLElement, rowId: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(`[data-timeline-row-id="${rowId}"]`);
}

async function measureRenderedRowHeight(options: {
  host: HTMLElement;
  scrollContainer: HTMLDivElement;
  rowId: string;
}): Promise<number> {
  let measuredHeightPx = 0;

  await vi.waitFor(
    async () => {
      const row = options.host.querySelector<HTMLElement>(
        `[data-timeline-row-id="${options.rowId}"]`,
      );
      expect(row, `Unable to locate row ${options.rowId}.`).toBeTruthy();
      row!.scrollIntoView({ block: "center" });
      options.scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForImagesToLoad(row!);
      await waitForLayout();
      measuredHeightPx = row!.getBoundingClientRect().height;
      expect(measuredHeightPx, `Unable to measure row ${options.rowId}.`).toBeGreaterThan(0);
    },
    {
      timeout: 4_000,
      interval: 16,
    },
  );

  return measuredHeightPx;
}

async function measureRenderedRowHeightAtCurrentScroll(options: {
  host: HTMLElement;
  rowId: string;
}): Promise<number> {
  return waitForElement(
    () => findRowElement(options.host, options.rowId),
    `Unable to locate row ${options.rowId}.`,
  ).then(async (row) => {
    await waitForImagesToLoad(row);
    await waitForLayout();
    return row.getBoundingClientRect().height;
  });
}

async function findButtonWithinRow(options: {
  host: HTMLElement;
  rowId: string;
  label: string;
}): Promise<HTMLButtonElement> {
  return waitForElement(
    () =>
      Array.from(
        findRowElement(options.host, options.rowId)?.querySelectorAll("button") ?? [],
      ).find((button) => button.textContent?.trim() === options.label) ?? null,
    `Unable to find "${options.label}" button within row ${options.rowId}.`,
  );
}

async function clickButtonWithinRow(options: {
  host: HTMLElement;
  rowId: string;
  label: string;
}): Promise<void> {
  const button = await findButtonWithinRow(options);
  button.click();
  await waitForLayout();
}

async function assertGeneratedCaseMatchesEstimatedHeights(options: {
  generatedCase: GeneratedTimelineHeightThreadCase;
  expandedWorkGroupIds?: string[];
  activeTurnInProgress?: boolean;
  viewport: ViewportSpec;
}) {
  const expectedRows = options.expandedWorkGroupIds
    ? buildGeneratedTimelineHeightRows(options.generatedCase, {
        expandedWorkGroupIds: options.expandedWorkGroupIds,
      })
    : buildGeneratedTimelineHeightRows(options.generatedCase);
  const mounted = await mountGeneratedTimeline(options);

  try {
    await waitForImagesToLoad(mounted.host);
    await waitForLayout();

    const timelineWidthPx = mounted.timelineRoot.getBoundingClientRect().width;
    expect(timelineWidthPx).toBeGreaterThan(0);

    for (const expectedRow of expectedRows) {
      const measuredHeightPx = await measureRenderedRowHeight({
        host: mounted.host,
        scrollContainer: mounted.scrollContainer,
        rowId: expectedRow.id,
      });
      const estimatedHeightPx = estimateTimelineRowHeight(expectedRow.input, {
        timelineWidthPx,
      });
      const tolerancePx = rowTolerancePx(expectedRow.input, options.viewport, estimatedHeightPx);
      const deltaPx = Math.abs(measuredHeightPx - estimatedHeightPx);

      expect(
        deltaPx,
        `row ${expectedRow.id} at ${options.viewport.name} should stay close to the estimator`,
      ).toBeLessThanOrEqual(tolerancePx);
    }
  } finally {
    await mounted.cleanup();
  }
}

describe("MessagesTimeline browser height parity", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps generated thread rows close to the estimator at the desktop viewport", async () => {
    const generatedCases = generateTimelineHeightThreadCases(DESKTOP_BROWSER_CASE_COUNT);

    for (const generatedCase of generatedCases) {
      await assertGeneratedCaseMatchesEstimatedHeights({
        generatedCase,
        viewport: DESKTOP_VIEWPORT,
      });
    }
  }, 30_000);

  it("keeps expanded work groups close to the estimator", async () => {
    const generatedCases = generateTimelineHeightThreadCases(6);

    for (const generatedCase of generatedCases) {
      await assertGeneratedCaseMatchesEstimatedHeights({
        generatedCase,
        expandedWorkGroupIds: [generatedCase.ids.workGroup],
        viewport: DESKTOP_VIEWPORT,
      });
    }
  }, 30_000);

  it("keeps selected generated edge cases close to the estimator on mobile", async () => {
    const edgeCases = generateTimelineHeightEdgeCases();

    for (const edgeCaseName of MOBILE_EDGE_CASE_NAMES) {
      const edgeCase = edgeCases.find((candidate) => candidate.name === edgeCaseName);
      expect(edgeCase, `Missing generated edge case ${edgeCaseName}`).toBeDefined();
      await assertGeneratedCaseMatchesEstimatedHeights({
        generatedCase: edgeCase!.generatedCase,
        activeTurnInProgress: edgeCaseName === "streaming-messages",
        viewport: MOBILE_VIEWPORT,
      });
    }
  }, 30_000);

  it("renders fallback attachment tiles without preview images and keeps height parity", async () => {
    const generatedCase = generateTimelineHeightEdgeCases().find(
      (candidate) => candidate.name === "attachment-fallback",
    )!.generatedCase;
    const mounted = await mountGeneratedTimeline({
      generatedCase,
      viewport: DESKTOP_VIEWPORT,
    });

    try {
      const userRowId = generatedCase.ids.user;
      const row = await waitForElement(
        () => findRowElement(mounted.host, userRowId),
        `Unable to locate row ${userRowId}.`,
      );

      expect(row.querySelectorAll("img").length).toBe(0);
      expect(row.textContent).toContain("attachment-1.png");

      const expectedRow = buildGeneratedTimelineHeightRows(generatedCase).find(
        (candidate) => candidate.id === userRowId,
      );
      expect(expectedRow).toBeDefined();
      const measuredHeightPx = await measureRenderedRowHeight({
        host: mounted.host,
        scrollContainer: mounted.scrollContainer,
        rowId: userRowId,
      });
      const estimatedHeightPx = estimateTimelineRowHeight(expectedRow!.input, {
        timelineWidthPx: mounted.timelineRoot.getBoundingClientRect().width,
      });

      expect(Math.abs(measuredHeightPx - estimatedHeightPx)).toBeLessThanOrEqual(128);
    } finally {
      await mounted.cleanup();
    }
  }, 30_000);

  it("renders streaming assistant and system rows with real height parity", async () => {
    const generatedCase = generateTimelineHeightEdgeCases().find(
      (candidate) => candidate.name === "streaming-messages",
    )!.generatedCase;

    await assertGeneratedCaseMatchesEstimatedHeights({
      generatedCase,
      activeTurnInProgress: true,
      viewport: DESKTOP_VIEWPORT,
    });
  }, 30_000);

  it("updates proposed-plan row height when expanding and collapsing a long plan", async () => {
    const generatedCase = generateTimelineHeightEdgeCases().find(
      (candidate) => candidate.name === "borderline-collapsible-plan",
    )!.generatedCase;
    const rowId = generatedCase.ids.longPlan;
    const mounted = await mountGeneratedTimeline({
      generatedCase,
      viewport: DESKTOP_VIEWPORT,
    });

    try {
      const collapsedHeightPx = await measureRenderedRowHeight({
        host: mounted.host,
        scrollContainer: mounted.scrollContainer,
        rowId,
      });

      await clickButtonWithinRow({
        host: mounted.host,
        rowId,
        label: "Expand plan",
      });
      const expandedHeightPx = await measureRenderedRowHeightAtCurrentScroll({
        host: mounted.host,
        rowId,
      });
      expect(expandedHeightPx).toBeGreaterThan(collapsedHeightPx);

      await clickButtonWithinRow({
        host: mounted.host,
        rowId,
        label: "Collapse plan",
      });
      const collapsedAgainHeightPx = await measureRenderedRowHeightAtCurrentScroll({
        host: mounted.host,
        rowId,
      });
      expect(Math.abs(collapsedAgainHeightPx - collapsedHeightPx)).toBeLessThanOrEqual(8);
    } finally {
      await mounted.cleanup();
    }
  }, 30_000);

  it("updates diff-summary row height when collapsing and expanding the changed-files tree", async () => {
    const generatedCase = generateTimelineHeightEdgeCases().find(
      (candidate) => candidate.name === "deep-diff-tree",
    )!.generatedCase;
    const rowId = generatedCase.ids.assistantDiffSummary;
    const mounted = await mountGeneratedTimeline({
      generatedCase,
      viewport: DESKTOP_VIEWPORT,
    });

    try {
      const expandedHeightPx = await measureRenderedRowHeight({
        host: mounted.host,
        scrollContainer: mounted.scrollContainer,
        rowId,
      });

      await clickButtonWithinRow({
        host: mounted.host,
        rowId,
        label: "Collapse all",
      });
      const collapsedHeightPx = await measureRenderedRowHeightAtCurrentScroll({
        host: mounted.host,
        rowId,
      });
      expect(collapsedHeightPx).toBeLessThan(expandedHeightPx);

      await clickButtonWithinRow({
        host: mounted.host,
        rowId,
        label: "Expand all",
      });
      const expandedAgainHeightPx = await measureRenderedRowHeightAtCurrentScroll({
        host: mounted.host,
        rowId,
      });
      expect(Math.abs(expandedAgainHeightPx - expandedHeightPx)).toBeLessThanOrEqual(12);
    } finally {
      await mounted.cleanup();
    }
  }, 30_000);
});
