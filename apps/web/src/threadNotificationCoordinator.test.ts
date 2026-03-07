import { ThreadId, TurnId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createThreadNotificationCoordinator } from "./threadNotificationCoordinator";
import type { ThreadNotificationEvent } from "./threadNotifications";

function makeEvent(
  overrides: Partial<ThreadNotificationEvent> = {},
): ThreadNotificationEvent {
  return {
    kind: "completed",
    notificationId: "completed:thread-1:turn-1:2026-03-07T12:00:05.000Z",
    threadId: ThreadId.makeUnsafe("thread-1"),
    turnId: TurnId.makeUnsafe("turn-1"),
    turnKey: "thread-1:turn-1",
    priority: "completion",
    ...overrides,
  };
}

describe("createThreadNotificationCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays completion notifications", () => {
    const coordinator = createThreadNotificationCoordinator({ completionDelayMs: 1000 });
    const emit = vi.fn();

    coordinator.schedule(makeEvent(), emit, { shouldEmit: () => true });
    expect(emit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(999);
    expect(emit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending completion when a same-turn action arrives", () => {
    const coordinator = createThreadNotificationCoordinator({ completionDelayMs: 1000 });
    const completionEmit = vi.fn();
    const actionEmit = vi.fn();

    coordinator.schedule(makeEvent(), completionEmit, { shouldEmit: () => true });
    coordinator.schedule(
      makeEvent({
        kind: "user-input-required",
        notificationId: "user-input:req-1",
        priority: "action",
      }),
      actionEmit,
    );

    expect(actionEmit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(completionEmit).not.toHaveBeenCalled();
  });

  it("does not cancel completions for different turns", () => {
    const coordinator = createThreadNotificationCoordinator({ completionDelayMs: 1000 });
    const completionEmit = vi.fn();
    const actionEmit = vi.fn();

    coordinator.schedule(makeEvent(), completionEmit, { shouldEmit: () => true });
    coordinator.schedule(
      makeEvent({
        kind: "user-input-required",
        notificationId: "user-input:req-2",
        turnId: TurnId.makeUnsafe("turn-2"),
        turnKey: "thread-1:turn-2",
        priority: "action",
      }),
      actionEmit,
    );

    expect(actionEmit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(completionEmit).toHaveBeenCalledTimes(1);
  });

  it("does not schedule the same completion notification twice", () => {
    const coordinator = createThreadNotificationCoordinator({ completionDelayMs: 1000 });
    const emit = vi.fn();
    const event = makeEvent();

    coordinator.schedule(event, emit, { shouldEmit: () => true });
    coordinator.schedule(event, emit, { shouldEmit: () => true });

    vi.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("does not emit the same action notification twice", () => {
    const coordinator = createThreadNotificationCoordinator({ completionDelayMs: 1000 });
    const emit = vi.fn();
    const event = makeEvent({
      kind: "user-input-required",
      notificationId: "approval:req-1",
      priority: "action",
    });

    coordinator.schedule(event, emit);
    coordinator.schedule(event, emit);

    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("replaces a pending completion for the same turn", () => {
    const coordinator = createThreadNotificationCoordinator({ completionDelayMs: 1000 });
    const emitA = vi.fn();
    const emitB = vi.fn();

    coordinator.schedule(
      makeEvent({
        notificationId: "completed:thread-1:turn-1:2026-03-07T12:00:05.000Z",
      }),
      emitA,
      { shouldEmit: () => true },
    );
    coordinator.schedule(
      makeEvent({
        notificationId: "completed:thread-1:turn-1:2026-03-07T12:00:06.000Z",
      }),
      emitB,
      { shouldEmit: () => true },
    );

    vi.advanceTimersByTime(1000);
    expect(emitA).not.toHaveBeenCalled();
    expect(emitB).toHaveBeenCalledTimes(1);
  });

  it("clears pending timers on dispose", () => {
    const coordinator = createThreadNotificationCoordinator({ completionDelayMs: 1000 });
    const emit = vi.fn();

    coordinator.schedule(makeEvent(), emit, { shouldEmit: () => true });
    coordinator.dispose();

    vi.advanceTimersByTime(1000);
    expect(emit).not.toHaveBeenCalled();
  });

  it("drops completion notifications when shouldEmit becomes false", () => {
    const coordinator = createThreadNotificationCoordinator({ completionDelayMs: 1000 });
    const emit = vi.fn();

    coordinator.schedule(makeEvent(), emit, { shouldEmit: () => false });

    vi.advanceTimersByTime(1000);
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not mark dropped completion notifications as seen", () => {
    const coordinator = createThreadNotificationCoordinator({ completionDelayMs: 1000 });
    const droppedEmit = vi.fn();
    const nextEmit = vi.fn();

    coordinator.schedule(
      makeEvent({
        notificationId: "completed:thread-1:turn-1:2026-03-07T12:00:05.000Z",
      }),
      droppedEmit,
      { shouldEmit: () => false },
    );

    vi.advanceTimersByTime(1000);
    expect(droppedEmit).not.toHaveBeenCalled();

    coordinator.schedule(
      makeEvent({
        notificationId: "completed:thread-1:turn-1:2026-03-07T12:00:06.000Z",
      }),
      nextEmit,
      { shouldEmit: () => true },
    );

    vi.advanceTimersByTime(1000);
    expect(nextEmit).toHaveBeenCalledTimes(1);
  });
});
