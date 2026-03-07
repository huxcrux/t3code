import { ThreadId } from "@t3tools/contracts";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useAppSettings } from "../appSettings";
import { useStore } from "../store";
import { createSeenNotificationRegistry } from "../threadNotificationRegistry";
import {
  buildThreadNotificationCopy,
  deriveThreadNotificationEvent,
  shouldNotifyForScope,
} from "../threadNotifications";
import type { Thread } from "../types";

function selectedThreadIdFromRouterMatches(
  matches: ReadonlyArray<{ params: Record<string, string> }>,
): ThreadId | null {
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    const threadId = match?.params.threadId;
    if (typeof threadId === "string" && threadId.length > 0) {
      return ThreadId.makeUnsafe(threadId);
    }
  }
  return null;
}

export function ThreadNotifications() {
  const navigate = useNavigate();
  const threads = useStore((store) => store.threads);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const { settings } = useAppSettings();
  const selectedThreadId = useRouterState({
    select: (state) => selectedThreadIdFromRouterMatches(state.matches as Array<{ params: Record<string, string> }>),
  });
  const previousThreadByIdRef = useRef<Map<ThreadId, Thread>>(new Map());
  const seenNotificationIdsRef = useRef(createSeenNotificationRegistry());
  const initializedRef = useRef(false);

  useEffect(() => {
    const nextThreadById = new Map(threads.map((thread) => [thread.id, thread] as const));
    if (!threadsHydrated) {
      previousThreadByIdRef.current = nextThreadById;
      return;
    }

    if (!initializedRef.current) {
      initializedRef.current = true;
      previousThreadByIdRef.current = nextThreadById;
      return;
    }

    if (typeof window === "undefined" || typeof Notification === "undefined") {
      previousThreadByIdRef.current = nextThreadById;
      return;
    }

    if (
      !settings.notifyOnUserInputRequired &&
      !settings.notifyOnCompleted
    ) {
      previousThreadByIdRef.current = nextThreadById;
      return;
    }

    if (Notification.permission !== "granted") {
      previousThreadByIdRef.current = nextThreadById;
      return;
    }

    const isBackground = document.visibilityState !== "visible" || !document.hasFocus();
    for (const thread of threads) {
      const event = deriveThreadNotificationEvent(previousThreadByIdRef.current.get(thread.id), thread);
      if (!event) {
        continue;
      }
      if (event.kind === "user-input-required" && !settings.notifyOnUserInputRequired) {
        continue;
      }
      if (event.kind === "completed" && !settings.notifyOnCompleted) {
        continue;
      }
      if (
        !shouldNotifyForScope({
          scope: settings.notificationScope,
          isBackground,
          selectedThreadId,
          threadId: thread.id,
        })
      ) {
        continue;
      }

      if (seenNotificationIdsRef.current.has(event.notificationId)) {
        continue;
      }
      seenNotificationIdsRef.current.mark(event.notificationId);

      const copy = buildThreadNotificationCopy(thread, event.kind);
      try {
        const notification = new Notification(copy.title, {
          body: copy.body,
        });
        notification.addEventListener("click", () => {
          window.focus();
          void navigate({
            to: "/$threadId",
            params: { threadId: thread.id },
          });
          notification.close();
        });
      } catch (error) {
        console.warn("Failed to show thread notification", {
          notificationId: event.notificationId,
          error,
        });
      }
    }

    previousThreadByIdRef.current = nextThreadById;
  }, [
    navigate,
    selectedThreadId,
    settings.notificationScope,
    settings.notifyOnCompleted,
    settings.notifyOnUserInputRequired,
    threads,
    threadsHydrated,
  ]);

  return null;
}
