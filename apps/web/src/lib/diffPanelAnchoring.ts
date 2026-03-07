import type { FileDiffMetadata } from "@pierre/diffs/react";

const DIFF_FILE_SELECTOR = "[data-diff-file-path]";

export interface DiffViewportAnchor {
  filePath: string;
  topWithinViewport: number;
  scrollTop: number;
  capturedAtPatchKey: string;
}

function normalizeTrackedPath(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) {
    return trimmed.slice(2);
  }
  return trimmed;
}

export function resolveStableDiffFilePaths(input: Pick<FileDiffMetadata, "name" | "prevName">): {
  filePath: string;
  prevFilePath: string | null;
} {
  const filePath = normalizeTrackedPath(input.name) ?? normalizeTrackedPath(input.prevName) ?? "";
  const prevFilePath = normalizeTrackedPath(input.prevName);
  return { filePath, prevFilePath };
}

export function buildStableDiffFileKey(
  input: Pick<FileDiffMetadata, "name" | "prevName">,
): string {
  const { filePath, prevFilePath } = resolveStableDiffFilePaths(input);
  return `${prevFilePath ?? ""}->${filePath}`;
}

export function shouldQueueSelectedFileScroll(
  previousSelectedFilePath: string | null,
  nextSelectedFilePath: string | null,
): boolean {
  return nextSelectedFilePath !== null && nextSelectedFilePath !== previousSelectedFilePath;
}

function elementMatchesTrackedPath(element: HTMLElement, trackedPath: string): boolean {
  return (
    element.dataset.diffFilePath === trackedPath || element.dataset.diffPrevFilePath === trackedPath
  );
}

export function findTrackedDiffFileElement(
  container: ParentNode,
  trackedPath: string,
): HTMLElement | null {
  const elements = Array.from(container.querySelectorAll<HTMLElement>(DIFF_FILE_SELECTOR));
  const directMatch =
    elements.find((element) => element.dataset.diffFilePath === trackedPath) ?? null;
  if (directMatch) {
    return directMatch;
  }
  return elements.find((element) => elementMatchesTrackedPath(element, trackedPath)) ?? null;
}

export function scrollTrackedDiffFileIntoView(
  container: ParentNode,
  trackedPath: string,
): string | null {
  const target = findTrackedDiffFileElement(container, trackedPath);
  if (!target) {
    return null;
  }
  target.scrollIntoView({ block: "nearest" });
  return target.dataset.diffFilePath ?? trackedPath;
}

export function captureVisibleDiffAnchor(
  container: HTMLElement,
  capturedAtPatchKey: string,
): DiffViewportAnchor | null {
  const elements = Array.from(container.querySelectorAll<HTMLElement>(DIFF_FILE_SELECTOR));
  if (elements.length === 0) {
    return null;
  }

  const containerRect = container.getBoundingClientRect();
  const containerTop = containerRect.top;
  const containerBottom = containerRect.bottom;
  const visibleElements = elements.filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.bottom > containerTop && rect.top < containerBottom;
  });
  const candidates = visibleElements.length > 0 ? visibleElements : elements;
  const target =
    candidates.reduce<HTMLElement | null>((closest, element) => {
      if (!element.dataset.diffFilePath) {
        return closest;
      }
      if (!closest) {
        return element;
      }
      const nextDistance = Math.abs(element.getBoundingClientRect().top - containerTop);
      const currentDistance = Math.abs(closest.getBoundingClientRect().top - containerTop);
      return nextDistance < currentDistance ? element : closest;
    }, null) ?? null;
  if (!target?.dataset.diffFilePath) {
    return null;
  }

  return {
    filePath: target.dataset.diffFilePath,
    topWithinViewport: target.getBoundingClientRect().top - containerTop,
    scrollTop: container.scrollTop,
    capturedAtPatchKey,
  };
}

export function restoreDiffAnchor(
  container: HTMLElement,
  anchor: DiffViewportAnchor,
): DiffViewportAnchor | null {
  const target = findTrackedDiffFileElement(container, anchor.filePath);
  if (!target?.dataset.diffFilePath) {
    return null;
  }

  const containerTop = container.getBoundingClientRect().top;
  const nextTop = target.getBoundingClientRect().top - containerTop;
  const delta = nextTop - anchor.topWithinViewport;
  if (Math.abs(delta) >= 0.5) {
    container.scrollTop += delta;
  }

  return {
    filePath: target.dataset.diffFilePath,
    topWithinViewport: target.getBoundingClientRect().top - containerTop,
    scrollTop: container.scrollTop,
    capturedAtPatchKey: anchor.capturedAtPatchKey,
  };
}
