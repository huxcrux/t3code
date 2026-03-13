import type { ThreadId, TurnId } from "@t3tools/contracts";

import type { AppNotificationScope, AppSettings } from "./appSettings";
import { resolveThreadStatusPill } from "./components/Sidebar.logic";
import { derivePendingApprovals, derivePendingUserInputs } from "./session-logic";
import type { ProposedPlan } from "./types";
import type { Thread } from "./types";

const DEFAULT_COMPLETION_DELAY_MS = 1000;
const DEFAULT_SEEN_NOTIFICATION_LIMIT = 512;

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

export interface ThreadNotificationController {
  update(input: {
    threads: Thread[];
    threadsHydrated: boolean;
    settings: Pick<
      AppSettings,
      "notifyOnCompleted" | "notifyOnUserInputRequired" | "notificationScope"
    >;
    selectedThreadId: ThreadId | null;
    supportsNotifications: boolean;
    notificationPermission: NotificationPermission | "unsupported";
    isBackground: boolean;
    getCurrentThread: (threadId: ThreadId) => Thread | undefined;
    showNotification: (input: { threadId: ThreadId; title: string; body: string }) => void;
  }): void;
  dispose(): void;
}

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

function canEmitCompletionNotification(
  event: ThreadNotificationEvent,
  getCurrentThread: (threadId: ThreadId) => Thread | undefined,
): boolean {
  const currentThread = getCurrentThread(event.threadId);
  if (!currentThread) {
    return false;
  }
  if (currentThread.latestTurn?.turnId !== event.turnId) {
    return false;
  }
  const currentCompletedAt = currentThread.latestTurn?.completedAt;
  if (!currentCompletedAt) {
    return false;
  }
  const currentNotificationId = `completed:${currentThread.id}:${event.turnId}:${currentCompletedAt}`;
  if (currentNotificationId !== event.notificationId) {
    return false;
  }

  return isThreadCompletionNotificationEligible(currentThread);
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

export function createThreadNotificationController(options?: {
  completionDelayMs?: number;
  seenLimit?: number;
}): ThreadNotificationController {
  let initialized = false;
  let previousThreadById = new Map<ThreadId, Thread>();
  const seenIds = new Set<string>();
  const completionDelayMs = options?.completionDelayMs ?? DEFAULT_COMPLETION_DELAY_MS;
  const seenLimit = options?.seenLimit ?? DEFAULT_SEEN_NOTIFICATION_LIMIT;
  const pendingCompletionsByTurnKey = new Map<
    string,
    { notificationId: string; timeoutId: ReturnType<typeof setTimeout> }
  >();

  const markSeen = (notificationId: string) => {
    if (seenIds.has(notificationId)) {
      return;
    }
    seenIds.add(notificationId);
    if (seenIds.size <= seenLimit) {
      return;
    }

    const oldestId = seenIds.values().next().value;
    if (typeof oldestId === "string") {
      seenIds.delete(oldestId);
    }
  };

  const clearPendingCompletion = (turnKey: string) => {
    const pending = pendingCompletionsByTurnKey.get(turnKey);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeoutId);
    pendingCompletionsByTurnKey.delete(turnKey);
  };

  const scheduleEvent = (
    event: ThreadNotificationEvent,
    emit: () => void,
    shouldEmit?: () => boolean,
  ) => {
    if (event.priority === "action") {
      if (event.turnKey) {
        clearPendingCompletion(event.turnKey);
      }
      if (seenIds.has(event.notificationId)) {
        return;
      }
      markSeen(event.notificationId);
      emit();
      return;
    }

    if (seenIds.has(event.notificationId)) {
      return;
    }

    if (!event.turnKey) {
      markSeen(event.notificationId);
      emit();
      return;
    }

    const pending = pendingCompletionsByTurnKey.get(event.turnKey);
    if (pending) {
      if (pending.notificationId === event.notificationId) {
        return;
      }
      clearPendingCompletion(event.turnKey);
    }

    const timeoutId = setTimeout(() => {
      pendingCompletionsByTurnKey.delete(event.turnKey!);
      if (seenIds.has(event.notificationId)) {
        return;
      }
      if (shouldEmit && !shouldEmit()) {
        return;
      }
      markSeen(event.notificationId);
      emit();
    }, completionDelayMs);

    pendingCompletionsByTurnKey.set(event.turnKey, {
      notificationId: event.notificationId,
      timeoutId,
    });
  };

  return {
    update(input) {
      const nextThreadById = new Map(input.threads.map((thread) => [thread.id, thread] as const));
      if (!input.threadsHydrated) {
        previousThreadById = nextThreadById;
        return;
      }

      if (!initialized) {
        initialized = true;
        previousThreadById = nextThreadById;
        return;
      }

      if (!input.supportsNotifications || input.notificationPermission !== "granted") {
        previousThreadById = nextThreadById;
        return;
      }

      for (const thread of input.threads) {
        const event = deriveThreadNotificationEvent(previousThreadById.get(thread.id), thread);
        if (!event) {
          continue;
        }
        if (event.kind === "user-input-required" && !input.settings.notifyOnUserInputRequired) {
          continue;
        }
        if (event.kind === "completed" && !input.settings.notifyOnCompleted) {
          continue;
        }
        if (
          !shouldNotifyForScope({
            scope: input.settings.notificationScope,
            isBackground: input.isBackground,
            selectedThreadId: input.selectedThreadId,
            threadId: thread.id,
          })
        ) {
          continue;
        }

        const copy = buildThreadNotificationCopy(thread, event.kind);
        const emit = () => {
          input.showNotification({
            threadId: thread.id,
            title: copy.title,
            body: copy.body,
          });
        };

        scheduleEvent(
          event,
          emit,
          event.priority === "completion"
            ? () => canEmitCompletionNotification(event, input.getCurrentThread)
            : undefined,
        );
      }

      previousThreadById = nextThreadById;
    },
    dispose() {
      for (const pending of pendingCompletionsByTurnKey.values()) {
        clearTimeout(pending.timeoutId);
      }
      pendingCompletionsByTurnKey.clear();
    },
  };
}
