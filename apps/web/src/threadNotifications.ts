import type { ThreadId } from "@t3tools/contracts";

import { deriveThreadDerivedStatus } from "./session-logic";
import type { AppNotificationScope } from "./appSettings";
import type { Thread } from "./types";

export type ThreadNotificationKind = "user-input-required" | "completed";

function isUserActionStatus(status: ReturnType<typeof deriveThreadDerivedStatus>): boolean {
  return status === "pending-approval" || status === "pending-user-action";
}

export function deriveThreadNotificationKind(
  previousThread: Thread | undefined,
  nextThread: Thread,
): ThreadNotificationKind | null {
  const previousStatus = previousThread ? deriveThreadDerivedStatus(previousThread) : null;
  const nextStatus = deriveThreadDerivedStatus(nextThread);

  if (isUserActionStatus(nextStatus) && !isUserActionStatus(previousStatus)) {
    return "user-input-required";
  }

  const previousCompletedAt = previousThread?.latestTurn?.completedAt ?? null;
  const nextCompletedAt = nextThread.latestTurn?.completedAt ?? null;
  if (
    nextCompletedAt &&
    nextCompletedAt !== previousCompletedAt &&
    !isUserActionStatus(nextStatus)
  ) {
    return "completed";
  }

  return null;
}

export function shouldNotifyForScope(input: {
  scope: AppNotificationScope;
  isBackground: boolean;
  selectedThreadId: ThreadId | null;
  threadId: ThreadId;
}): boolean {
  switch (input.scope) {
    case "always":
      return true;
    case "non-selected-thread":
      return input.selectedThreadId === null
        ? true
        : input.threadId !== input.selectedThreadId || input.isBackground;
    case "background":
    default:
      return input.isBackground;
  }
}

export function buildThreadNotificationCopy(
  thread: Thread,
  kind: ThreadNotificationKind,
): { title: string; body: string } {
  if (kind === "completed") {
    return {
      title: "Thread completed",
      body: thread.title,
    };
  }

  const status = deriveThreadDerivedStatus(thread);
  if (status === "pending-approval") {
    return {
      title: "Approval required",
      body: thread.title,
    };
  }

  return {
    title: "User input required",
    body: thread.title,
  };
}
