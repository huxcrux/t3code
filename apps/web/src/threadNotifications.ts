import type { ThreadId, TurnId } from "@t3tools/contracts";

import type { AppNotificationScope } from "./appSettings";
import { resolveThreadStatusPill } from "./components/Sidebar.logic";
import { derivePendingApprovals, derivePendingUserInputs } from "./session-logic";
import type { ProposedPlan } from "./types";
import type { Thread } from "./types";

export type ThreadNotificationKind = "user-input-required" | "completed";
export interface ThreadNotificationEvent {
  kind: ThreadNotificationKind;
  notificationId: string;
  threadId: ThreadId;
  turnId: TurnId | null;
  turnKey: string | null;
  priority: "action" | "completion";
}

type ThreadCompletionEligibilityInput = Pick<
  Thread,
  "activities" | "interactionMode" | "proposedPlans" | "session" | "latestTurn" | "lastVisitedAt"
>;

function toTurnKey(threadId: ThreadId, turnId: TurnId | null): string | null {
  return turnId ? `${threadId}:${turnId}` : null;
}

function deriveStatusPill(
  thread: Pick<
    Thread,
    "activities" | "interactionMode" | "lastVisitedAt" | "latestTurn" | "proposedPlans" | "session"
  >,
) {
  const pendingApprovals = derivePendingApprovals(thread.activities);
  const pendingUserInputs = derivePendingUserInputs(thread.activities);

  return {
    pendingApprovals,
    pendingUserInputs,
    statusPill: resolveThreadStatusPill({
      thread,
      hasPendingApprovals: pendingApprovals.length > 0,
      hasPendingUserInput: pendingUserInputs.length > 0,
    }),
  };
}

export function isThreadCompletionNotificationEligible(
  thread: ThreadCompletionEligibilityInput,
): boolean {
  return deriveStatusPill(thread).statusPill?.label === "Completed";
}

function deriveLatestPlanForCurrentTurn(thread: Pick<Thread, "proposedPlans" | "latestTurn">): ProposedPlan | null {
  if (!thread.latestTurn) {
    return null;
  }

  return [...thread.proposedPlans]
    .filter((proposedPlan) => proposedPlan.turnId === thread.latestTurn?.turnId)
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1) ?? null;
}

function deriveUserActionNotificationEvent(thread: Thread): ThreadNotificationEvent | null {
  const { pendingApprovals, pendingUserInputs, statusPill } = deriveStatusPill(thread);
  const [oldestPendingApproval] = pendingApprovals;
  if (oldestPendingApproval) {
    const turnId = oldestPendingApproval.turnId ?? thread.latestTurn?.turnId ?? null;
    return {
      kind: "user-input-required",
      notificationId: `approval:${oldestPendingApproval.requestId}`,
      threadId: thread.id,
      turnId,
      turnKey: toTurnKey(thread.id, turnId),
      priority: "action",
    };
  }

  const [oldestPendingUserInput] = pendingUserInputs;
  if (oldestPendingUserInput) {
    const turnId = oldestPendingUserInput.turnId ?? thread.latestTurn?.turnId ?? null;
    return {
      kind: "user-input-required",
      notificationId: `user-input:${oldestPendingUserInput.requestId}`,
      threadId: thread.id,
      turnId,
      turnKey: toTurnKey(thread.id, turnId),
      priority: "action",
    };
  }

  if (statusPill?.label !== "Plan Ready") {
    return null;
  }

  const latestPlan = deriveLatestPlanForCurrentTurn(thread);
  if (!latestPlan) {
    return null;
  }

  const turnId = thread.latestTurn?.turnId ?? null;
  return {
    kind: "user-input-required",
    notificationId: `plan:${latestPlan.id}:${latestPlan.updatedAt}`,
    threadId: thread.id,
    turnId,
    turnKey: toTurnKey(thread.id, turnId),
    priority: "action",
  };
}

function deriveCompletionNotificationEvent(thread: Thread): ThreadNotificationEvent | null {
  const completedAt = thread.latestTurn?.completedAt;
  const turnId = thread.latestTurn?.turnId;
  if (!completedAt || !turnId || !isThreadCompletionNotificationEligible(thread)) {
    return null;
  }

  return {
    kind: "completed",
    notificationId: `completed:${thread.id}:${turnId}:${completedAt}`,
    threadId: thread.id,
    turnId,
    turnKey: toTurnKey(thread.id, turnId),
    priority: "completion",
  };
}

export function deriveThreadNotificationEvent(
  previousThread: Thread | undefined,
  nextThread: Thread,
): ThreadNotificationEvent | null {
  const nextUserActionEvent = deriveUserActionNotificationEvent(nextThread);
  if (nextUserActionEvent) {
    const previousUserActionEvent = previousThread
      ? deriveUserActionNotificationEvent(previousThread)
      : null;
    if (previousUserActionEvent?.notificationId === nextUserActionEvent.notificationId) {
      return null;
    }
    return nextUserActionEvent;
  }

  const nextCompletionEvent = deriveCompletionNotificationEvent(nextThread);
  if (!nextCompletionEvent) {
    return null;
  }

  const previousCompletionEvent = previousThread
    ? deriveCompletionNotificationEvent(previousThread)
    : null;
  if (previousCompletionEvent?.notificationId === nextCompletionEvent.notificationId) {
    return null;
  }

  return nextCompletionEvent;
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

  if (derivePendingApprovals(thread.activities).length > 0) {
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
