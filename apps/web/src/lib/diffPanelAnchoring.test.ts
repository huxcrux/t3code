import { describe, expect, it, vi } from "vitest";
import type { FileDiffMetadata } from "@pierre/diffs/react";
import {
  buildStableDiffFileKey,
  captureVisibleDiffAnchor,
  findTrackedDiffFileElement,
  restoreDiffAnchor,
  resolveStableDiffFilePaths,
  scrollTrackedDiffFileIntoView,
  shouldQueueSelectedFileScroll,
} from "./diffPanelAnchoring";

function asFileDiffMetadata(input: Partial<FileDiffMetadata>): FileDiffMetadata {
  return input as FileDiffMetadata;
}

interface MockDataset {
  diffFilePath?: string;
  diffPrevFilePath?: string;
}

interface MockElement {
  dataset: MockDataset;
  scrollIntoView: ReturnType<typeof vi.fn>;
  getBoundingClientRect: () => DOMRect;
}

interface MockContainer {
  scrollTop: number;
  querySelectorAll: (selector: string) => MockElement[];
  getBoundingClientRect: () => DOMRect;
}

function createMockElement(input: {
  filePath?: string;
  prevFilePath?: string;
  rect: { top: number; height: number; left?: number; width?: number };
}): MockElement {
  const element = {
    dataset: {} as MockDataset,
    scrollIntoView: vi.fn(),
    getBoundingClientRect: () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        toJSON: () => "",
      }) satisfies DOMRect,
  } satisfies MockElement;

  if (input.filePath) {
    element.dataset.diffFilePath = input.filePath;
  }
  if (input.prevFilePath) {
    element.dataset.diffPrevFilePath = input.prevFilePath;
  }
  setRect(element, input.rect);
  return element;
}

function createMockContainer(input: {
  scrollTop: number;
  rect: { top: number; height: number; left?: number; width?: number };
  elements: MockElement[];
}): MockContainer {
  const container = {
    scrollTop: input.scrollTop,
    querySelectorAll: vi.fn((selector: string) =>
      selector === "[data-diff-file-path]" ? input.elements : [],
    ),
    getBoundingClientRect: () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        toJSON: () => "",
      }) satisfies DOMRect,
  } satisfies MockContainer;
  setRect(container, input.rect);
  return container;
}

function setRect(
  element: { getBoundingClientRect?: () => DOMRect },
  rect: { top: number; height: number; left?: number; width?: number },
) {
  const top = rect.top;
  const height = rect.height;
  const bottom = top + height;
  const left = rect.left ?? 0;
  const width = rect.width ?? 100;
  const right = left + width;
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () =>
      ({
        x: left,
        y: top,
        top,
        bottom,
        left,
        right,
        width,
        height,
        toJSON: () => "",
      }) satisfies DOMRect,
  });
}

describe("buildStableDiffFileKey", () => {
  it("stays stable across content changes for the same file identity", () => {
    const before = asFileDiffMetadata({ name: "b/src/app.ts", prevName: "a/src/app.ts" });
    const after = asFileDiffMetadata({ name: "b/src/app.ts", prevName: "a/src/app.ts" });

    expect(buildStableDiffFileKey(before)).toBe(buildStableDiffFileKey(after));
  });

  it("is rename-aware", () => {
    const renamed = asFileDiffMetadata({ name: "b/src/new.ts", prevName: "a/src/old.ts" });

    expect(buildStableDiffFileKey(renamed)).toBe("src/old.ts->src/new.ts");
  });

  it("normalizes a/b prefixes when resolving paths", () => {
    expect(
      resolveStableDiffFilePaths(
        asFileDiffMetadata({ name: "b/src/new.ts", prevName: "a/src/old.ts" }),
      ),
    ).toEqual({
      filePath: "src/new.ts",
      prevFilePath: "src/old.ts",
    });
  });
});

describe("selected file scrolling helpers", () => {
  it("queues a scroll only when the selected file path changes", () => {
    expect(shouldQueueSelectedFileScroll(null, "src/a.ts")).toBe(true);
    expect(shouldQueueSelectedFileScroll("src/a.ts", "src/a.ts")).toBe(false);
    expect(shouldQueueSelectedFileScroll("src/a.ts", null)).toBe(false);
  });

  it("matches renamed files by previous path and resolves to the current path", () => {
    const file = createMockElement({
      filePath: "src/new.ts",
      prevFilePath: "src/old.ts",
      rect: { top: 120, height: 60 },
    });
    const container = createMockContainer({
      scrollTop: 0,
      rect: { top: 100, height: 200 },
      elements: [file],
    });

    expect(findTrackedDiffFileElement(container as unknown as ParentNode, "src/old.ts")).toBe(
      file,
    );
    expect(scrollTrackedDiffFileIntoView(container as unknown as ParentNode, "src/old.ts")).toBe(
      "src/new.ts",
    );
    expect(file.scrollIntoView).toHaveBeenCalledTimes(1);
  });
});

describe("diff viewport anchoring", () => {
  it("captures the visible file nearest the viewport top", () => {
    const first = createMockElement({
      filePath: "src/first.ts",
      rect: { top: 90, height: 80 },
    });
    const second = createMockElement({
      filePath: "src/second.ts",
      rect: { top: 125, height: 120 },
    });
    const container = createMockContainer({
      scrollTop: 120,
      rect: { top: 100, height: 300 },
      elements: [first, second],
    });

    expect(captureVisibleDiffAnchor(container as unknown as HTMLElement, "patch:1")).toEqual({
      filePath: "src/first.ts",
      topWithinViewport: -10,
      scrollTop: 120,
      capturedAtPatchKey: "patch:1",
    });
  });

  it("restores scroll position when the anchored file moves", () => {
    const file = createMockElement({
      filePath: "src/app.ts",
      rect: { top: 150, height: 120 },
    });
    const container = createMockContainer({
      scrollTop: 200,
      rect: { top: 100, height: 300 },
      elements: [file],
    });

    const anchor = captureVisibleDiffAnchor(container as unknown as HTMLElement, "patch:1");
    if (!anchor) {
      throw new Error("Expected an anchor to be captured.");
    }

    setRect(file, { top: 210, height: 120 });

    expect(restoreDiffAnchor(container as unknown as HTMLElement, anchor)).toMatchObject({
      filePath: "src/app.ts",
      scrollTop: 260,
      capturedAtPatchKey: "patch:1",
    });
    expect(container.scrollTop).toBe(260);
  });

  it("does nothing when the anchored file disappears", () => {
    const container = createMockContainer({
      scrollTop: 80,
      rect: { top: 100, height: 300 },
      elements: [],
    });

    expect(
      restoreDiffAnchor(container as unknown as HTMLElement, {
        filePath: "src/missing.ts",
        topWithinViewport: 20,
        scrollTop: 80,
        capturedAtPatchKey: "patch:1",
      }),
    ).toBeNull();
    expect(container.scrollTop).toBe(80);
  });
});
