import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

describe("readCodexAccountPlanViaAppServer", () => {
  it("returns undefined when the codex binary fails to spawn", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      spawn: () => {
        throw new Error("spawn codex ENOENT");
      },
    }));

    const { readCodexAccountPlanViaAppServer } = await import("./codexAccount");

    await expect(Effect.runPromise(readCodexAccountPlanViaAppServer())).resolves.toBeUndefined();

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });
});
