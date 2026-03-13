import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useStore } from "../store";
import { createThreadNotificationController } from "../threadNotifications";

export function ThreadNotifications() {
  const navigate = useNavigate();
  const threads = useStore((store) => store.threads);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const controllerRef = useRef(createThreadNotificationController());

  useEffect(() => {
    const supportsNotifications =
      typeof window !== "undefined" && typeof Notification !== "undefined";

    controllerRef.current.update({
      threads,
      threadsHydrated,
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
  }, [navigate, threads, threadsHydrated]);

  useEffect(() => {
    const controller = controllerRef.current;
    return () => {
      controller.dispose();
    };
  }, []);

  return null;
}
