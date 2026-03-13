import type { ThreadId } from "@t3tools/contracts";

import type { AppSettings } from "./appSettings";
import { createThreadNotificationCoordinator } from "./threadNotificationCoordinator";
import {
  buildThreadNotificationCopy,
  deriveThreadNotificationEvent,
  isThreadCompletionNotificationEligible,
  shouldNotifyForScope,
  type ThreadNotificationEvent,
} from "./threadNotifications";
import type { Thread } from "./types";

type NotificationSettings = Pick<
  AppSettings,
  "notificationScope" | "notifyOnCompleted" | "notifyOnUserInputRequired"
>;

export interface ThreadNotificationManager {
  update(input: {
    threads: Thread[];
    threadsHydrated: boolean;
    settings: NotificationSettings;
    selectedThreadId: ThreadId | null;
    supportsNotifications: boolean;
    notificationPermission: NotificationPermission | "unsupported";
    isBackground: boolean;
    getCurrentThread: (threadId: ThreadId) => Thread | undefined;
    showNotification: (input: { threadId: ThreadId; title: string; body: string }) => void;
  }): void;
  dispose(): void;
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

export function createThreadNotificationManager(): ThreadNotificationManager {
  let previousThreadById = new Map<ThreadId, Thread>();
  let initialized = false;
  const coordinator = createThreadNotificationCoordinator();

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

      if (!input.settings.notifyOnUserInputRequired && !input.settings.notifyOnCompleted) {
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

        if (event.priority === "action") {
          coordinator.schedule(event, emit);
          continue;
        }

        coordinator.schedule(event, emit, {
          shouldEmit: () => canEmitCompletionNotification(event, input.getCurrentThread),
        });
      }

      previousThreadById = nextThreadById;
    },
    dispose() {
      coordinator.dispose();
    },
  };
}
