import { ThreadId } from "@t3tools/contracts";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useAppSettings } from "../appSettings";
import { useStore } from "../store";
import { createThreadNotificationController } from "../threadNotifications";

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
  const controllerRef = useRef(createThreadNotificationController());

  useEffect(() => {
    const supportsNotifications =
      typeof window !== "undefined" && typeof Notification !== "undefined";

    controllerRef.current.update({
      threads,
      threadsHydrated,
      settings,
      selectedThreadId,
      supportsNotifications,
      notificationPermission: supportsNotifications ? Notification.permission : "unsupported",
      isBackground:
        supportsNotifications &&
        (document.visibilityState !== "visible" || !document.hasFocus()),
      getCurrentThread: (threadId) =>
        useStore.getState().threads.find((thread) => thread.id === threadId),
      showNotification: ({ threadId, title, body }) => {
        try {
          const notification = new Notification(title, { body });
          notification.addEventListener("click", () => {
            window.focus();
            void navigate({
              to: "/$threadId",
              params: { threadId },
            });
            notification.close();
          });
        } catch (error) {
          console.warn("Failed to show thread notification", {
            threadId,
            title,
            error,
          });
        }
      },
    });
  }, [navigate, selectedThreadId, settings, threads, threadsHydrated]);

  useEffect(() => {
    const controller = controllerRef.current;
    return () => {
      controller.dispose();
    };
  }, []);

  return null;
}
