import type { Thread } from "./types";

function normalizeWorktreePath(path: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

export function getOrphanedWorktreePathsForDeletedThreads(
  threads: readonly Thread[],
  deletedThreadIds: ReadonlySet<Thread["id"]>,
): string[] {
  if (deletedThreadIds.size === 0) {
    return [];
  }

  const deletedPaths = new Set<string>();
  const survivingPaths = new Set<string>();

  for (const thread of threads) {
    const normalizedPath = normalizeWorktreePath(thread.worktreePath);
    if (!normalizedPath) {
      continue;
    }

    if (deletedThreadIds.has(thread.id)) {
      deletedPaths.add(normalizedPath);
      continue;
    }

    survivingPaths.add(normalizedPath);
  }

  return [...deletedPaths].filter((path) => !survivingPaths.has(path));
}

export function getOrphanedWorktreePathForThread(
  threads: readonly Thread[],
  threadId: Thread["id"],
): string | null {
  const orphanedPaths = getOrphanedWorktreePathsForDeletedThreads(threads, new Set([threadId]));
  return orphanedPaths[0] ?? null;
}

export function formatWorktreePathForDisplay(worktreePath: string): string {
  const trimmed = worktreePath.trim();
  if (!trimmed) {
    return worktreePath;
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  const lastPart = parts[parts.length - 1]?.trim() ?? "";
  return lastPart.length > 0 ? lastPart : trimmed;
}
