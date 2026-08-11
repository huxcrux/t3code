// @effect-diagnostics nodeBuiltinImport:off - Test creates a temporary executable fixture.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import type { CopilotClientOptions } from "@github/copilot-sdk";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";

import {
  authSnapshotFromCopilotSdk,
  buildCopilotClientOptions,
  capabilitiesFromCopilotModel,
  formatCopilotProbeError,
  modelsFromCopilotSdk,
  normalizeCopilotRuntimeEnvironment,
  stopCopilotClient,
  toCopilotProbeError,
} from "./copilotRuntime.ts";

function assertStdioConnection(connection: CopilotClientOptions["connection"]) {
  NodeAssert.equal(connection?.kind, "stdio");
  return connection;
}

const POSIX_SHELL_FALLBACKS = ["/bin/bash", "/usr/bin/bash", "/bin/sh"] as const;

describe("stopCopilotClient", () => {
  it.effect("recovers cleanup errors with a successful force stop", () =>
    Effect.gen(function* () {
      let forceStopCalls = 0;
      const cleanupError = new Error("runtime shutdown timed out");

      yield* stopCopilotClient({
        stop: async () => [cleanupError],
        forceStop: async () => {
          forceStopCalls += 1;
        },
      });

      NodeAssert.equal(forceStopCalls, 1);
    }),
  );

  it.effect("does not force stop after clean SDK shutdown", () =>
    Effect.gen(function* () {
      let forceStopCalls = 0;

      yield* stopCopilotClient({
        stop: async () => [],
        forceStop: async () => {
          forceStopCalls += 1;
        },
      });

      NodeAssert.equal(forceStopCalls, 0);
    }),
  );

  it.effect("recovers a graceful shutdown timeout with a successful force stop", () =>
    Effect.gen(function* () {
      let forceStopCalls = 0;
      const stopFiber = yield* stopCopilotClient({
        stop: () => new Promise<Error[]>(() => undefined),
        forceStop: async () => {
          forceStopCalls += 1;
        },
      }).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(stopFiber);

      NodeAssert.equal(forceStopCalls, 1);
    }),
  );

  it.effect("surfaces cleanup errors when force stop also fails", () =>
    Effect.gen(function* () {
      const cleanupError = new Error("runtime shutdown timed out");
      const forceStopError = new Error("could not kill process");

      const error = yield* stopCopilotClient({
        stop: async () => [cleanupError],
        forceStop: async () => {
          throw forceStopError;
        },
      }).pipe(Effect.flip);

      NodeAssert.deepStrictEqual(error.cleanupErrors, [cleanupError]);
      NodeAssert.equal(error.forceStopCause, forceStopError);
      NodeAssert.equal(
        error.message,
        "Copilot client cleanup was incomplete (cleanupErrors=1, gracefulStopFailures=0, forceStopFailures=1).",
      );
    }),
  );
});

describe("buildCopilotClientOptions", () => {
  it("leaves POSIX PATH hydration to the shared server environment setup", () => {
    const env = normalizeCopilotRuntimeEnvironment({ PATH: "/custom/bin:/bin" }, "darwin");

    NodeAssert.equal(env.PATH, "/custom/bin:/bin");
  });

  it("formats Copilot probe failures from nested causes", () => {
    const formatted = formatCopilotProbeError({
      cause: toCopilotProbeError(new Error("spawn ENOENT")),
      settings: {
        enabled: true,
        binaryPath: "/missing/copilot",
        customModels: [],
      },
    });

    NodeAssert.equal(formatted.installed, false);
    NodeAssert.equal(
      formatted.message,
      "The configured Copilot binary could not be started: /missing/copilot.",
    );
  });

  it("normalizes and deduplicates built-in Copilot SDK model slugs", () => {
    const models = modelsFromCopilotSdk({
      models: [
        {
          id: "4.1",
          name: "",
          capabilities: {
            supports: { vision: false, reasoningEffort: false },
            limits: { max_prompt_tokens: 272_000, max_context_window_tokens: 400_000 },
          },
          billing: {
            tokenPrices: { contextMax: 272_000 },
          },
        } as unknown as Parameters<typeof modelsFromCopilotSdk>[0]["models"][number],
        {
          id: "gpt-4.1",
          name: "GPT 4.1 duplicate",
          capabilities: {
            supports: { vision: false, reasoningEffort: false },
            limits: { max_prompt_tokens: 272_000, max_context_window_tokens: 400_000 },
          },
          billing: {
            tokenPrices: { contextMax: 272_000 },
          },
        } as unknown as Parameters<typeof modelsFromCopilotSdk>[0]["models"][number],
      ],
      customModels: ["gpt-4.1"],
    });

    NodeAssert.equal(models.length, 1);
    const [model] = models;
    NodeAssert.equal(model?.slug, "gpt-4.1");
    NodeAssert.equal(model?.isCustom, false);
  });

  describe("capabilitiesFromCopilotModel", () => {
    it("adds a context tier selector for long-context Copilot models", () => {
      const capabilities = capabilitiesFromCopilotModel({
        capabilities: {
          supports: { vision: false, reasoningEffort: true },
          limits: { max_prompt_tokens: 922_000, max_context_window_tokens: 1_050_000 },
        },
        billing: {
          tokenPrices: {
            contextMax: 272_000,
            longContext: { contextMax: 922_000 },
          },
        },
        supportedReasoningEfforts: ["none", "low", "medium", "high", "max"],
        defaultReasoningEffort: "medium",
      });

      NodeAssert.deepStrictEqual(capabilities.optionDescriptors, [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "none", label: "None" },
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
            { id: "max", label: "Max" },
          ],
          currentValue: "medium",
        },
        {
          id: "contextTier",
          label: "Context Window",
          type: "select",
          options: [
            { id: "default", label: "272K", isDefault: true },
            { id: "long_context", label: "1.05M" },
          ],
          currentValue: "default",
        },
      ]);
    });

    it("omits the context tier selector for regular-context Copilot models", () => {
      const capabilities = capabilitiesFromCopilotModel({
        capabilities: {
          supports: { vision: false, reasoningEffort: false },
          limits: { max_prompt_tokens: 272_000, max_context_window_tokens: 400_000 },
        },
        billing: {
          tokenPrices: {
            contextMax: 272_000,
          },
        },
      });

      NodeAssert.deepStrictEqual(capabilities.optionDescriptors, []);
    });
  });

  it("hydrates a missing POSIX SHELL for Copilot shell spawning", () => {
    const env = normalizeCopilotRuntimeEnvironment({}, "darwin");

    NodeAssert.ok(POSIX_SHELL_FALLBACKS.some((shell) => shell === env.SHELL));
  });

  it("replaces POSIX SHELL values that the Copilot CLI rejects", () => {
    const fallbackShell = normalizeCopilotRuntimeEnvironment({}, "darwin").SHELL;
    const relativeShellEnv = normalizeCopilotRuntimeEnvironment({ SHELL: "bash" }, "darwin");
    const shellWithWhitespaceEnv = normalizeCopilotRuntimeEnvironment(
      { SHELL: "/bin/bash --noprofile" },
      "darwin",
    );

    NodeAssert.equal(relativeShellEnv.SHELL, fallbackShell);
    NodeAssert.equal(shellWithWhitespaceEnv.SHELL, fallbackShell);
  });

  it("preserves valid POSIX SHELL paths", () => {
    const validShell = normalizeCopilotRuntimeEnvironment({}, "darwin").SHELL;
    NodeAssert.ok(validShell);

    const env = normalizeCopilotRuntimeEnvironment({ SHELL: validShell }, "darwin");

    NodeAssert.equal(env.SHELL, validShell);
  });

  it("forces the Copilot POSIX shell spawn backend to avoid node-pty failures", () => {
    const env = normalizeCopilotRuntimeEnvironment({}, "darwin");

    NodeAssert.equal(env.COPILOT_FEATURE_FLAGS, "SHELL_SPAWN_BACKEND");
    NodeAssert.equal(env.COPILOT_EXP_COPILOT_CLI_SHELL_SPAWN_BACKEND, "true");
  });

  it("preserves existing Copilot feature flags while enabling the shell spawn backend", () => {
    const env = normalizeCopilotRuntimeEnvironment(
      { COPILOT_FEATURE_FLAGS: "FOCUSED_TOOLS, SHELL_SPAWN_BACKEND, MCP_APPS" },
      "darwin",
    );

    NodeAssert.equal(env.COPILOT_FEATURE_FLAGS, "FOCUSED_TOOLS,SHELL_SPAWN_BACKEND,MCP_APPS");
  });

  it("does not apply POSIX shell normalization on Windows", () => {
    const env = normalizeCopilotRuntimeEnvironment({ SHELL: "bash" }, "win32");

    NodeAssert.equal(env.SHELL, "bash");
    NodeAssert.equal(env.COPILOT_FEATURE_FLAGS, undefined);
    NodeAssert.equal(env.COPILOT_EXP_COPILOT_CLI_SHELL_SPAWN_BACKEND, undefined);
  });

  it.layer(NodeServices.layer)("Copilot CLI command resolution", (it) => {
    it.effect("requires a configured Copilot CLI path", () =>
      Effect.gen(function* () {
        const error = yield* buildCopilotClientOptions({
          settings: {
            enabled: true,
            binaryPath: "",
            customModels: [],
          },
          cwd: "/tmp/project",
          baseDirectory: "/tmp/t3-copilot-home",
          env: {
            PATH: "/usr/bin",
            COPILOT_CLI_PATH: "/opt/homebrew/bin/copilot",
            GITHUB_TOKEN: "github-token",
          },
          platform: "darwin",
          logLevel: "error",
        }).pipe(Effect.flip);

        NodeAssert.equal(error.detail, "Configure a Copilot binary path.");
      }),
    );

    it.effect("prefers the configured binary path over any inherited CLI path override", () =>
      Effect.gen(function* () {
        const configuredBinaryPath = process.execPath;

        const options = yield* buildCopilotClientOptions({
          settings: {
            enabled: true,
            binaryPath: configuredBinaryPath,
            customModels: [],
          },
          env: {
            COPILOT_CLI_PATH: "/opt/homebrew/bin/copilot",
          },
          platform: "darwin",
        });

        const connection = assertStdioConnection(options.connection);
        NodeAssert.equal(connection.path, configuredBinaryPath);
        NodeAssert.equal(options.env?.COPILOT_CLI_PATH, undefined);
      }),
    );

    it.effect("resolves the default Copilot command from the host user PATH", () =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "copilot-user-path-"));
        const binDir = NodePath.join(baseDir, "bin");
        NodeFS.mkdirSync(binDir, { recursive: true });
        const binaryPath = NodePath.join(binDir, "copilot");
        NodeFS.writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
        NodeFS.chmodSync(binaryPath, 0o755);

        const options = yield* buildCopilotClientOptions({
          settings: {
            enabled: true,
            binaryPath: "copilot",
            customModels: [],
          },
          cwd: "/tmp/project",
          platform: "darwin",
        }).pipe(
          Effect.provideService(HostProcessEnvironment, {
            PATH: `${binDir}${NodePath.delimiter}/usr/bin`,
          }),
        );

        const connection = assertStdioConnection(options.connection);
        NodeAssert.equal(connection.path, binaryPath);
        NodeAssert.equal(options.env?.PATH, `${binDir}${NodePath.delimiter}/usr/bin`);
        NodeFS.rmSync(baseDir, { recursive: true, force: true });
      }),
    );

    it.effect("resolves configured relative binary paths from the binary path base directory", () =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "copilot-cli-base-"));
        const workspaceDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "copilot-cli-cwd-"));
        const binDir = NodePath.join(baseDir, "bin");
        NodeFS.mkdirSync(binDir, { recursive: true });
        const binaryPath = NodePath.join(binDir, "copilot");
        NodeFS.writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
        NodeFS.chmodSync(binaryPath, 0o755);

        const options = yield* buildCopilotClientOptions({
          settings: {
            enabled: true,
            binaryPath: "./bin/copilot",
            customModels: [],
          },
          cwd: workspaceDir,
          binaryPathBaseDirectory: baseDir,
          env: { PATH: "/usr/bin" },
          platform: "darwin",
        });

        const connection = assertStdioConnection(options.connection);
        NodeAssert.equal(connection.path, binaryPath);
        NodeAssert.equal(options.workingDirectory, workspaceDir);
        NodeFS.rmSync(baseDir, { recursive: true, force: true });
        NodeFS.rmSync(workspaceDir, { recursive: true, force: true });
      }),
    );
  });

  it("omits the generic signed-in user prefix from authenticated Copilot labels", () => {
    const snapshot = authSnapshotFromCopilotSdk({
      isAuthenticated: true,
      authType: "user",
      host: "https://github.com",
      statusMessage: "octocat",
      login: "octocat",
    });

    NodeAssert.equal(snapshot.auth.status, "authenticated");
    NodeAssert.equal(snapshot.auth.type, "user");
    NodeAssert.equal(snapshot.auth.label, "@octocat - github.com");
  });

  it("prefers the richer authenticated status message when it differs from the raw login", () => {
    const snapshot = authSnapshotFromCopilotSdk({
      isAuthenticated: true,
      authType: "gh-cli",
      host: "https://github.com",
      statusMessage: "zortos293 (via gh)",
      login: "zortos293",
    });

    NodeAssert.equal(snapshot.auth.status, "authenticated");
    NodeAssert.equal(snapshot.auth.type, "gh-cli");
    NodeAssert.equal(snapshot.auth.label, "zortos293 (via gh)");
  });
});
