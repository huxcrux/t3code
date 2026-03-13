import { EventId, MessageId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildThreadNotificationCopy,
  createThreadNotificationController,
  deriveThreadNotificationEvent,
} from "./threadNotifications";
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

function makeApprovalRequestedActivity() {
  return {
    id: EventId.makeUnsafe("evt-approval-open"),
    createdAt: "2026-03-07T12:00:05.000Z",
    tone: "approval" as const,
    kind: "approval.requested" as const,
    summary: "Approval required",
    payload: {
      requestId: "req-approval",
      requestKind: "command",
      detail: "Run command",
    },
    turnId: TurnId.makeUnsafe("turn-1"),
  };
}

function makeUserInputRequestedActivity() {
  return {
    id: EventId.makeUnsafe("evt-user-input-open"),
    createdAt: "2026-03-07T12:00:05.000Z",
    tone: "info" as const,
    kind: "user-input.requested" as const,
    summary: "User input requested",
    payload: {
      requestId: "req-user-input",
      questions: [
        {
          id: "sandbox_mode",
          header: "Sandbox",
          question: "Which mode should be used?",
          options: [
            {
              label: "workspace-write",
              description: "Allow workspace writes only",
            },
          ],
        },
      ],
    },
    turnId: TurnId.makeUnsafe("turn-1"),
  };
}

describe("deriveThreadNotificationEvent", () => {
  it("emits approval notifications for pending approvals", () => {
    expect(
      deriveThreadNotificationEvent(
        makeThread(),
        makeThread({
          activities: [makeApprovalRequestedActivity()],
        }),
      ),
    ).toEqual({
      kind: "user-input-required",
      notificationId: "approval:req-approval",
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: TurnId.makeUnsafe("turn-1"),
      turnKey: "thread-1:turn-1",
      priority: "action",
    });
  });

  it("emits user-input notifications for pending prompts", () => {
    expect(
      deriveThreadNotificationEvent(
        makeThread(),
        makeThread({
          activities: [makeUserInputRequestedActivity()],
        }),
      ),
    ).toEqual({
      kind: "user-input-required",
      notificationId: "user-input:req-user-input",
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: TurnId.makeUnsafe("turn-1"),
      turnKey: "thread-1:turn-1",
      priority: "action",
    });
  });

  it("emits plan notifications from existing plan-ready status", () => {
    expect(
      deriveThreadNotificationEvent(
        makeThread(),
        makeThread({
          interactionMode: "plan",
          latestTurn: {
            turnId: TurnId.makeUnsafe("turn-1"),
            state: "completed",
            requestedAt: "2026-03-07T12:00:00.000Z",
            startedAt: "2026-03-07T12:00:01.000Z",
            completedAt: "2026-03-07T12:00:05.000Z",
            assistantMessageId: null,
          },
          proposedPlans: [
            {
              id: "plan:thread-1:turn:turn-1",
              turnId: TurnId.makeUnsafe("turn-1"),
              planMarkdown: "# Ship it",
              createdAt: "2026-03-07T12:00:04.000Z",
              updatedAt: "2026-03-07T12:00:04.000Z",
            },
          ],
        }),
      ),
    ).toEqual({
      kind: "user-input-required",
      notificationId: "plan:plan:thread-1:turn:turn-1:2026-03-07T12:00:04.000Z",
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: TurnId.makeUnsafe("turn-1"),
      turnKey: "thread-1:turn-1",
      priority: "action",
    });
  });

  it("emits completion notifications once per completed turn", () => {
    const previous = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "running",
        requestedAt: "2026-03-07T12:00:00.000Z",
        startedAt: "2026-03-07T12:00:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const next = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "completed",
        requestedAt: "2026-03-07T12:00:00.000Z",
        startedAt: "2026-03-07T12:00:01.000Z",
        completedAt: "2026-03-07T12:00:05.000Z",
        assistantMessageId: MessageId.makeUnsafe("assistant-1"),
      },
    });

    expect(deriveThreadNotificationEvent(previous, next)?.kind).toBe("completed");
    expect(deriveThreadNotificationEvent(next, next)).toBeNull();
  });
});

describe("buildThreadNotificationCopy", () => {
  it("uses status-specific notification copy", () => {
    expect(
      buildThreadNotificationCopy(
        makeThread({
          activities: [makeApprovalRequestedActivity()],
        }),
        "user-input-required",
      ),
    ).toEqual({
      title: "Approval required",
      body: "Thread title",
    });

    expect(buildThreadNotificationCopy(makeThread(), "completed")).toEqual({
      title: "Thread completed",
      body: "Thread title",
    });
  });
});

describe("createThreadNotificationController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores the first hydrated snapshot and then emits action notifications", () => {
    const controller = createThreadNotificationController();
    const showNotification = vi.fn();
    const initialThread = makeThread();
    const updatedThread = makeThread({
      activities: [makeApprovalRequestedActivity()],
    });

    controller.update({
      threads: [initialThread],
      threadsHydrated: true,
      supportsNotifications: true,
      notificationPermission: "granted",
      isBackground: true,
      getCurrentThread: () => initialThread,
      showNotification,
    });

    controller.update({
      threads: [updatedThread],
      threadsHydrated: true,
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

  it("delays completion notifications and drops them when the turn is no longer current", () => {
    const controller = createThreadNotificationController({ completionDelayMs: 1000 });
    const showNotification = vi.fn();
    const previousThread = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "running",
        requestedAt: "2026-03-07T12:00:00.000Z",
        startedAt: "2026-03-07T12:00:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const completedThread = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "completed",
        requestedAt: "2026-03-07T12:00:00.000Z",
        startedAt: "2026-03-07T12:00:01.000Z",
        completedAt: "2026-03-07T12:00:05.000Z",
        assistantMessageId: MessageId.makeUnsafe("assistant-1"),
      },
    });

    controller.update({
      threads: [previousThread],
      threadsHydrated: true,
      supportsNotifications: true,
      notificationPermission: "granted",
      isBackground: true,
      getCurrentThread: () => previousThread,
      showNotification,
    });

    controller.update({
      threads: [completedThread],
      threadsHydrated: true,
      supportsNotifications: true,
      notificationPermission: "granted",
      isBackground: true,
      getCurrentThread: () => makeThread(),
      showNotification,
    });

    vi.advanceTimersByTime(1000);
    expect(showNotification).not.toHaveBeenCalled();
  });
});
