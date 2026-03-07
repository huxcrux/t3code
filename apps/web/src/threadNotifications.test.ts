import { EventId, MessageId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  buildThreadNotificationCopy,
  deriveThreadNotificationEvent,
  shouldNotifyForScope,
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
    updatedAt: "2026-03-07T12:00:00.000Z",
    latestTurn: null,
    lastVisitedAt: undefined,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

function makeApprovalRequestedActivity(overrides: Partial<Thread["activities"][number]> = {}) {
  return {
    id: EventId.makeUnsafe("evt-approval-open"),
    createdAt: "2026-03-07T12:00:05.000Z",
    tone: "approval" as const,
    kind: "approval.requested",
    summary: "Approval required",
    payload: {
      requestId: "req-approval",
      requestKind: "command",
      detail: "Run command",
    },
    turnId: TurnId.makeUnsafe("turn-1"),
    ...overrides,
  };
}

function makeUserInputRequestedActivity(overrides: Partial<Thread["activities"][number]> = {}) {
  return {
    id: EventId.makeUnsafe("evt-user-input-open"),
    createdAt: "2026-03-07T12:00:05.000Z",
    tone: "info" as const,
    kind: "user-input.requested",
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
    ...overrides,
  };
}

describe("deriveThreadNotificationEvent", () => {
  it("emits approval notifications with action priority and turn metadata", () => {
    const previous = makeThread();
    const next = makeThread({
      activities: [makeApprovalRequestedActivity()],
    });

    expect(deriveThreadNotificationEvent(previous, next)).toEqual({
      kind: "user-input-required",
      notificationId: "approval:req-approval",
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: TurnId.makeUnsafe("turn-1"),
      turnKey: "thread-1:turn-1",
      priority: "action",
    });
  });

  it("emits user-input notifications with action priority and turn metadata", () => {
    const previous = makeThread();
    const next = makeThread({
      activities: [makeUserInputRequestedActivity()],
    });

    expect(deriveThreadNotificationEvent(previous, next)).toEqual({
      kind: "user-input-required",
      notificationId: "user-input:req-user-input",
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: TurnId.makeUnsafe("turn-1"),
      turnKey: "thread-1:turn-1",
      priority: "action",
    });
  });

  it("emits completed notifications with completion priority and turn metadata", () => {
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

    expect(deriveThreadNotificationEvent(previous, next)).toEqual({
      kind: "completed",
      notificationId: "completed:thread-1:turn-1:2026-03-07T12:00:05.000Z",
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: TurnId.makeUnsafe("turn-1"),
      turnKey: "thread-1:turn-1",
      priority: "completion",
    });
  });

  it("emits plan notifications with action priority and turn metadata", () => {
    const previous = makeThread();
    const next = makeThread({
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
    });

    expect(deriveThreadNotificationEvent(previous, next)).toEqual({
      kind: "user-input-required",
      notificationId: "plan:plan:thread-1:turn:turn-1:2026-03-07T12:00:04.000Z",
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: TurnId.makeUnsafe("turn-1"),
      turnKey: "thread-1:turn-1",
      priority: "action",
    });
  });

  it("does not emit completed when the prior snapshot already had the same completion", () => {
    const previous = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "completed",
        requestedAt: "2026-03-07T12:00:00.000Z",
        startedAt: "2026-03-07T12:00:01.000Z",
        completedAt: "2026-03-07T12:00:05.000Z",
        assistantMessageId: MessageId.makeUnsafe("assistant-1"),
      },
    });
    const next = makeThread({
      updatedAt: "2026-03-07T12:00:06.000Z",
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "completed",
        requestedAt: "2026-03-07T12:00:00.000Z",
        startedAt: "2026-03-07T12:00:01.000Z",
        completedAt: "2026-03-07T12:00:05.000Z",
        assistantMessageId: MessageId.makeUnsafe("assistant-1"),
      },
    });

    expect(deriveThreadNotificationEvent(previous, next)).toBeNull();
  });

  it("does not derive completed when approval is pending", () => {
    const previous = makeThread();
    const next = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "completed",
        requestedAt: "2026-03-07T12:00:00.000Z",
        startedAt: "2026-03-07T12:00:01.000Z",
        completedAt: "2026-03-07T12:00:05.000Z",
        assistantMessageId: null,
      },
      activities: [makeApprovalRequestedActivity()],
    });

    expect(deriveThreadNotificationEvent(previous, next)).toEqual({
      kind: "user-input-required",
      notificationId: "approval:req-approval",
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: TurnId.makeUnsafe("turn-1"),
      turnKey: "thread-1:turn-1",
      priority: "action",
    });
  });

  it("does not derive completed when user input is pending", () => {
    const previous = makeThread();
    const next = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "completed",
        requestedAt: "2026-03-07T12:00:00.000Z",
        startedAt: "2026-03-07T12:00:01.000Z",
        completedAt: "2026-03-07T12:00:05.000Z",
        assistantMessageId: null,
      },
      activities: [makeUserInputRequestedActivity()],
    });

    expect(deriveThreadNotificationEvent(previous, next)).toEqual({
      kind: "user-input-required",
      notificationId: "user-input:req-user-input",
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: TurnId.makeUnsafe("turn-1"),
      turnKey: "thread-1:turn-1",
      priority: "action",
    });
  });

  it("does not derive completed when a proposed-plan action is pending", () => {
    const previous = makeThread();
    const next = makeThread({
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
    });

    expect(deriveThreadNotificationEvent(previous, next)).toEqual({
      kind: "user-input-required",
      notificationId: "plan:plan:thread-1:turn:turn-1:2026-03-07T12:00:04.000Z",
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: TurnId.makeUnsafe("turn-1"),
      turnKey: "thread-1:turn-1",
      priority: "action",
    });
  });

  it("prefers user-action notifications over completion notifications", () => {
    const previous = makeThread();
    const next = makeThread({
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
    });

    expect(deriveThreadNotificationEvent(previous, next)).toEqual({
      kind: "user-input-required",
      notificationId: "plan:plan:thread-1:turn:turn-1:2026-03-07T12:00:04.000Z",
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: TurnId.makeUnsafe("turn-1"),
      turnKey: "thread-1:turn-1",
      priority: "action",
    });
  });

  it("emits a new notification when the latest plan revision changes", () => {
    const previous = makeThread({
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
    });
    const next = makeThread({
      updatedAt: "2026-03-07T12:00:07.000Z",
      latestTurn: previous.latestTurn,
      proposedPlans: [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.makeUnsafe("turn-1"),
          planMarkdown: "# Ship it",
          createdAt: "2026-03-07T12:00:04.000Z",
          updatedAt: "2026-03-07T12:00:06.000Z",
        },
      ],
    });

    expect(deriveThreadNotificationEvent(previous, next)).toEqual({
      kind: "user-input-required",
      notificationId: "plan:plan:thread-1:turn:turn-1:2026-03-07T12:00:06.000Z",
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: TurnId.makeUnsafe("turn-1"),
      turnKey: "thread-1:turn-1",
      priority: "action",
    });
  });

  it("uses the fallback id when user action is detected without a stable source id", async () => {
    vi.resetModules();
    vi.doMock("./session-logic", async () => {
      const actual = await vi.importActual<typeof import("./session-logic")>("./session-logic");
      return {
        ...actual,
        derivePendingApprovals: () => [],
        derivePendingUserInputs: () => [],
        hasPendingProposedPlanAction: () => false,
        deriveThreadDerivedStatus: (thread: Pick<Thread, "updatedAt">) =>
          thread.updatedAt === "2026-03-07T12:00:05.000Z" ? "pending-user-action" : null,
      };
    });

    try {
      const { deriveThreadNotificationEvent: deriveFallbackThreadNotificationEvent } = await import(
        "./threadNotifications"
      );
      const previous = makeThread();
      const next = makeThread({
        updatedAt: "2026-03-07T12:00:05.000Z",
      });

      expect(deriveFallbackThreadNotificationEvent(previous, next)).toEqual({
        kind: "user-input-required",
        notificationId: "user-action:thread-1:none:2026-03-07T12:00:05.000Z",
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: null,
        turnKey: null,
        priority: "action",
      });
    } finally {
      vi.doUnmock("./session-logic");
      vi.resetModules();
    }
  });
});

describe("shouldNotifyForScope", () => {
  const selectedThreadId = ThreadId.makeUnsafe("thread-1");
  const otherThreadId = ThreadId.makeUnsafe("thread-2");

  it("only notifies in background for the default scope", () => {
    expect(
      shouldNotifyForScope({
        scope: "background",
        isBackground: false,
        selectedThreadId,
        threadId: selectedThreadId,
      }),
    ).toBe(false);
    expect(
      shouldNotifyForScope({
        scope: "background",
        isBackground: true,
        selectedThreadId,
        threadId: selectedThreadId,
      }),
    ).toBe(true);
  });

  it("notifies for non-selected threads even when the app is active", () => {
    expect(
      shouldNotifyForScope({
        scope: "non-selected-thread",
        isBackground: false,
        selectedThreadId,
        threadId: otherThreadId,
      }),
    ).toBe(true);
    expect(
      shouldNotifyForScope({
        scope: "non-selected-thread",
        isBackground: false,
        selectedThreadId,
        threadId: selectedThreadId,
      }),
    ).toBe(false);
  });

  it("always notifies for the always scope", () => {
    expect(
      shouldNotifyForScope({
        scope: "always",
        isBackground: false,
        selectedThreadId,
        threadId: selectedThreadId,
      }),
    ).toBe(true);
  });
});

describe("buildThreadNotificationCopy", () => {
  it("formats completion copy with the thread title in the body", () => {
    expect(buildThreadNotificationCopy(makeThread(), "completed")).toEqual({
      title: "Thread completed",
      body: "Thread title",
    });
  });
});
