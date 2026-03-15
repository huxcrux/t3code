import type { Thread } from "./types";

export type ThreadActivityLike = Pick<Thread, "id" | "createdAt" | "latestTurn">;

export function resolveThreadLastActivityAt(
  thread: Pick<Thread, "createdAt" | "latestTurn">,
): string {
  return (
    thread.latestTurn?.completedAt ??
    thread.latestTurn?.startedAt ??
    thread.latestTurn?.requestedAt ??
    thread.createdAt
  );
}

export function compareThreadsByLastActivityDesc(
  left: ThreadActivityLike,
  right: ThreadActivityLike,
): number {
  const byTimestamp =
    Date.parse(resolveThreadLastActivityAt(right)) - Date.parse(resolveThreadLastActivityAt(left));
  if (!Number.isNaN(byTimestamp) && byTimestamp !== 0) {
    return byTimestamp;
  }
  return right.id.localeCompare(left.id);
}
