import { EventId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import { createThreadNotificationManager } from "./threadNotificationManager";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread title",
    model: "gpt-5.4",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-07T12:00:00.000Z",
    latestTurn: null,
    lastVisitedAt: undefined,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

function makeNotificationSettings() {
  return {
    notifyOnUserInputRequired: true,
    notifyOnCompleted: true,
    notificationScope: "always" as const,
  };
}

describe("createThreadNotificationManager", () => {
  it("does not notify for the first hydrated snapshot", () => {
    const manager = createThreadNotificationManager();
    const showNotification = vi.fn();
    const thread = makeThread({
      activities: [
        {
          id: EventId.makeUnsafe("evt-approval-open"),
          createdAt: "2026-03-07T12:00:05.000Z",
          tone: "approval",
          kind: "approval.requested",
          summary: "Approval required",
          payload: {
            requestId: "req-approval",
            requestKind: "command",
          },
          turnId: TurnId.makeUnsafe("turn-1"),
        },
      ],
    });

    manager.update({
      threads: [thread],
      threadsHydrated: true,
      settings: makeNotificationSettings(),
      selectedThreadId: null,
      supportsNotifications: true,
      notificationPermission: "granted",
      isBackground: true,
      getCurrentThread: () => thread,
      showNotification,
    });

    expect(showNotification).not.toHaveBeenCalled();
  });

  it("emits notifications on later updates", () => {
    const manager = createThreadNotificationManager();
    const showNotification = vi.fn();
    const initialThread = makeThread();
    const updatedThread = makeThread({
      activities: [
        {
          id: EventId.makeUnsafe("evt-approval-open"),
          createdAt: "2026-03-07T12:00:05.000Z",
          tone: "approval",
          kind: "approval.requested",
          summary: "Approval required",
          payload: {
            requestId: "req-approval",
            requestKind: "command",
          },
          turnId: TurnId.makeUnsafe("turn-1"),
        },
      ],
    });

    manager.update({
      threads: [initialThread],
      threadsHydrated: true,
      settings: makeNotificationSettings(),
      selectedThreadId: null,
      supportsNotifications: true,
      notificationPermission: "granted",
      isBackground: true,
      getCurrentThread: () => initialThread,
      showNotification,
    });

    manager.update({
      threads: [updatedThread],
      threadsHydrated: true,
      settings: makeNotificationSettings(),
      selectedThreadId: null,
      supportsNotifications: true,
      notificationPermission: "granted",
      isBackground: true,
      getCurrentThread: () => updatedThread,
      showNotification,
    });

    expect(showNotification).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
      title: "Approval required",
      body: "Thread title",
    });
  });
});
