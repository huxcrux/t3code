import { describe, expect, it } from "vitest";
import { Effect, Sink, Stream } from "effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import { readCodexAccountPlanViaAppServer } from "./codexAccount";

const encoder = new TextEncoder();

function mockHandle(input: {
  readonly stdout?: ReadonlyArray<string>;
  readonly stdin?: ChildProcessSpawner.ChildProcessHandle["stdin"];
  readonly stderr?: ChildProcessSpawner.ChildProcessHandle["stderr"];
}) {
  const stdoutChunks = input.stdout?.map((line) => encoder.encode(line)) ?? [];

  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: input.stdin ?? Sink.drain,
    stdout: stdoutChunks.length > 0 ? Stream.fromIterable(stdoutChunks) : Stream.empty,
    stderr: input.stderr ?? Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

describe("readCodexAccountPlanViaAppServer", () => {
  it("returns the plan from the app-server account/read response", async () => {
    const effect = readCodexAccountPlanViaAppServer().pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            mockHandle({
              stdout: [
                '{"id":1,"result":{}}\n',
                '{"id":2,"result":{"account":{"type":"chatgpt","planType":"team"}}}\n',
              ],
            }),
          ),
        ),
      ),
    );

    await expect(Effect.runPromise(effect)).resolves.toBe("team");
  });

  it("returns undefined when the codex binary fails to spawn", async () => {
    const effect = readCodexAccountPlanViaAppServer().pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              description: "spawn codex ENOENT",
            }),
          ),
        ),
      ),
    );

    await expect(Effect.runPromise(effect)).resolves.toBeUndefined();
  });

  it("returns undefined when the app-server stdin pipe closes during request writes", async () => {
    const effect = readCodexAccountPlanViaAppServer().pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            mockHandle({
              stdin: Sink.failSync(() =>
                PlatformError.systemError({
                  _tag: "BadResource",
                  module: "ChildProcess",
                  method: "stdin.write",
                  description: "write EPIPE",
                }),
              ),
            }),
          ),
        ),
      ),
    );

    await expect(Effect.runPromise(effect)).resolves.toBeUndefined();
  });

  it("reads stdout even when stdin never completes", async () => {
    const effect = readCodexAccountPlanViaAppServer().pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            mockHandle({
              stdin: Sink.never as ChildProcessSpawner.ChildProcessHandle["stdin"],
              stdout: [
                '{"id":1,"result":{}}\n',
                '{"id":2,"result":{"account":{"type":"chatgpt","planType":"team"}}}\n',
              ],
            }),
          ),
        ),
      ),
    );

    await expect(Effect.runPromise(effect)).resolves.toBe("team");
  });

  it("returns undefined when initialize responds with a string error", async () => {
    const effect = readCodexAccountPlanViaAppServer().pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            mockHandle({
              stdout: ['{"id":1,"error":"unauthorized"}\n'],
            }),
          ),
        ),
      ),
    );

    await expect(Effect.runPromise(effect)).resolves.toBeUndefined();
  });

  it("returns undefined when account/read responds with a string error", async () => {
    const effect = readCodexAccountPlanViaAppServer().pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            mockHandle({
              stdout: ['{"id":1,"result":{}}\n', '{"id":2,"error":"unauthorized"}\n'],
            }),
          ),
        ),
      ),
    );

    await expect(Effect.runPromise(effect)).resolves.toBeUndefined();
  });
});
