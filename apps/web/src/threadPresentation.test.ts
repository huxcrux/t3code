import { describe, expect, it } from "vitest";
import {
  compareThreadsByLastActivityDesc,
  resolveThreadLastActivityAt,
} from "./threadPresentation";

function makeLatestTurn(overrides?: {
  requestedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}) {
  return {
    turnId: "turn-1" as never,
    state: "completed" as const,
    assistantMessageId: null,
    requestedAt: overrides?.requestedAt ?? "2026-03-09T10:00:00.000Z",
    startedAt: overrides?.startedAt ?? "2026-03-09T10:01:00.000Z",
    completedAt: overrides?.completedAt ?? "2026-03-09T10:05:00.000Z",
  };
}

describe("resolveThreadLastActivityAt", () => {
  it("prefers completedAt, then startedAt, then requestedAt, then createdAt", () => {
    expect(
      resolveThreadLastActivityAt({
        createdAt: "2026-03-09T09:00:00.000Z",
        latestTurn: makeLatestTurn(),
      }),
    ).toBe("2026-03-09T10:05:00.000Z");

    expect(
      resolveThreadLastActivityAt({
        createdAt: "2026-03-09T09:00:00.000Z",
        latestTurn: makeLatestTurn({ completedAt: null }),
      }),
    ).toBe("2026-03-09T10:01:00.000Z");

    expect(
      resolveThreadLastActivityAt({
        createdAt: "2026-03-09T09:00:00.000Z",
        latestTurn: makeLatestTurn({ completedAt: null, startedAt: null }),
      }),
    ).toBe("2026-03-09T10:00:00.000Z");

    expect(
      resolveThreadLastActivityAt({
        createdAt: "2026-03-09T09:00:00.000Z",
        latestTurn: null,
      }),
    ).toBe("2026-03-09T09:00:00.000Z");
  });
});

describe("compareThreadsByLastActivityDesc", () => {
  it("sorts newer thread activity before older thread activity", () => {
    const sorted = [
      {
        id: "thread-a" as never,
        createdAt: "2026-03-09T09:00:00.000Z",
        latestTurn: makeLatestTurn({ completedAt: "2026-03-09T10:01:00.000Z" }),
      },
      {
        id: "thread-c" as never,
        createdAt: "2026-03-09T08:00:00.000Z",
        latestTurn: makeLatestTurn({ completedAt: "2026-03-09T10:05:00.000Z" }),
      },
      {
        id: "thread-b" as never,
        createdAt: "2026-03-09T10:05:00.000Z",
        latestTurn: null,
      },
    ].toSorted(compareThreadsByLastActivityDesc);

    expect(sorted.map((thread) => thread.id)).toEqual(["thread-c", "thread-b", "thread-a"]);
  });
});
