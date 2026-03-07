import { EventId, MessageId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildThreadNotificationCopy,
  deriveThreadNotificationKind,
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
    latestTurn: null,
    lastVisitedAt: undefined,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

describe("deriveThreadNotificationKind", () => {
  it("emits user-input-required when a thread enters a blocked user-action state", () => {
    const previous = makeThread();
    const next = makeThread({
      activities: [
        {
          id: EventId.makeUnsafe("evt-user-input-open"),
          createdAt: "2026-03-07T12:00:05.000Z",
          tone: "info",
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
        },
      ],
    });

    expect(deriveThreadNotificationKind(previous, next)).toBe("user-input-required");
  });

  it("emits completed when a new turn completion arrives without a blocked user action", () => {
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

    expect(deriveThreadNotificationKind(previous, next)).toBe("completed");
  });

  it("does not emit completed when the thread instead transitions into pending user action", () => {
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

    expect(deriveThreadNotificationKind(previous, next)).toBe("user-input-required");
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
