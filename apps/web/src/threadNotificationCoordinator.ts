import { createSeenNotificationRegistry } from "./threadNotificationRegistry";
import type { ThreadNotificationEvent } from "./threadNotifications";

const DEFAULT_COMPLETION_DELAY_MS = 1000;
const DEFAULT_SEEN_LIMIT = 512;

export interface ThreadNotificationCoordinator {
  schedule(
    event: ThreadNotificationEvent,
    emit: () => void,
    options?: {
      shouldEmit?: () => boolean;
    },
  ): void;
  dispose(): void;
}

export function createThreadNotificationCoordinator(options?: {
  completionDelayMs?: number;
  seenLimit?: number;
}): ThreadNotificationCoordinator {
  const completionDelayMs = options?.completionDelayMs ?? DEFAULT_COMPLETION_DELAY_MS;
  const seenIds = createSeenNotificationRegistry(options?.seenLimit ?? DEFAULT_SEEN_LIMIT);
  const pendingCompletionsByTurnKey = new Map<
    string,
    { notificationId: string; timeoutId: ReturnType<typeof setTimeout> }
  >();

  const clearPendingCompletion = (turnKey: string): void => {
    const pending = pendingCompletionsByTurnKey.get(turnKey);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeoutId);
    pendingCompletionsByTurnKey.delete(turnKey);
  };

  return {
    schedule(event, emit, options) {
      if (event.priority === "action") {
        if (event.turnKey) {
          clearPendingCompletion(event.turnKey);
        }
        if (seenIds.has(event.notificationId)) {
          return;
        }
        seenIds.mark(event.notificationId);
        emit();
        return;
      }

      if (seenIds.has(event.notificationId)) {
        return;
      }

      if (!event.turnKey) {
        seenIds.mark(event.notificationId);
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
        if (options?.shouldEmit && !options.shouldEmit()) {
          return;
        }
        seenIds.mark(event.notificationId);
        emit();
      }, completionDelayMs);

      pendingCompletionsByTurnKey.set(event.turnKey, {
        notificationId: event.notificationId,
        timeoutId,
      });
    },
    dispose() {
      for (const pending of pendingCompletionsByTurnKey.values()) {
        clearTimeout(pending.timeoutId);
      }
      pendingCompletionsByTurnKey.clear();
    },
  };
}
