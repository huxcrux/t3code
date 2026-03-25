import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
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

  it("returns undefined when the app-server stdin pipe closes during request writes", async () => {
    vi.resetModules();

    class MockStdin extends EventEmitter {
      private emittedError = false;

      write() {
        if (!this.emittedError) {
          this.emittedError = true;
          queueMicrotask(() => {
            this.emit("error", new Error("write EPIPE"));
          });
        }
        return false;
      }
    }

    class MockChild extends EventEmitter {
      readonly stdout = new PassThrough();
      readonly stdin = new MockStdin();

      kill() {}
    }

    vi.doMock("node:child_process", () => ({
      spawn: () => new MockChild(),
    }));

    const { readCodexAccountPlanViaAppServer } = await import("./codexAccount");

    await expect(Effect.runPromise(readCodexAccountPlanViaAppServer())).resolves.toBeUndefined();

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });
});
