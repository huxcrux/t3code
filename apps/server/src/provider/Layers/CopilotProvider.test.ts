import * as NodeAssert from "node:assert/strict";

import { beforeEach, describe, it } from "@effect/vitest";
import { CopilotSettings } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import { checkCopilotProviderStatus, makePendingCopilotProvider } from "./CopilotProvider.ts";

const runtimeMock = vi.hoisted(() => {
  const state = {
    listModelsError: null as Error | null,
    createClientError: null as Error | null,
    authenticated: true,
    quotaResponse: { quotaSnapshots: {} } as unknown,
    quotaError: null as Error | null,
    quotaEndpointAvailable: true,
    quotaCalls: [] as unknown[],
    createCalls: 0,
    stopErrors: [] as Error[],
    stopCalls: 0,
    forceStopCalls: 0,
  };

  return {
    state,
    reset() {
      state.listModelsError = null;
      state.createClientError = null;
      state.authenticated = true;
      state.quotaResponse = { quotaSnapshots: {} };
      state.quotaError = null;
      state.quotaEndpointAvailable = true;
      state.quotaCalls = [];
      state.createCalls = 0;
      state.stopErrors = [];
      state.stopCalls = 0;
      state.forceStopCalls = 0;
    },
  };
});

vi.mock("../copilotRuntime.ts", async () => {
  const actual =
    await vi.importActual<typeof import("../copilotRuntime.ts")>("../copilotRuntime.ts");

  return {
    ...actual,
    createCopilotClient: vi.fn(() => {
      runtimeMock.state.createCalls += 1;
      if (runtimeMock.state.createClientError) {
        return Effect.fail(runtimeMock.state.createClientError);
      }
      return Effect.succeed({
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => {
          runtimeMock.state.stopCalls += 1;
          return runtimeMock.state.stopErrors;
        }),
        forceStop: vi.fn(async () => {
          runtimeMock.state.forceStopCalls += 1;
        }),
        getStatus: vi.fn(async () => ({
          version: "1.0.32",
          protocolVersion: 3,
        })),
        getAuthStatus: vi.fn(async () => ({
          isAuthenticated: runtimeMock.state.authenticated,
          authType: "gh-cli",
          host: "https://github.com",
          statusMessage: "zortos293 (via gh)",
          login: "zortos293",
        })),
        listModels: vi.fn(async () => {
          if (runtimeMock.state.listModelsError) {
            throw runtimeMock.state.listModelsError;
          }
          return [];
        }),
        rpc: runtimeMock.state.quotaEndpointAvailable
          ? {
              account: {
                getQuota: vi.fn(async (params: unknown) => {
                  runtimeMock.state.quotaCalls.push(params);
                  if (runtimeMock.state.quotaError) throw runtimeMock.state.quotaError;
                  return runtimeMock.state.quotaResponse;
                }),
              },
            }
          : {},
      });
    }),
  };
});

beforeEach(() => {
  vi.useRealTimers();
  runtimeMock.reset();
});

const defaultCopilotSettings: CopilotSettings = Schema.decodeSync(CopilotSettings)({});

describe("CopilotProvider status", () => {
  it.effect("reports context-window support in pending and checked snapshots", () =>
    Effect.gen(function* () {
      NodeAssert.equal(
        makePendingCopilotProvider(defaultCopilotSettings).reportsContextWindow,
        true,
      );
      const snapshot = yield* checkCopilotProviderStatus({
        settings: defaultCopilotSettings,
        cwd: process.cwd(),
      });
      NodeAssert.equal(snapshot.reportsContextWindow, true);
    }),
  );

  it.effect("surfaces underlying SDK errors instead of leaking Effect.tryPromise text", () =>
    Effect.gen(function* () {
      runtimeMock.state.listModelsError = new Error("401 Unauthorized");

      const snapshot = yield* checkCopilotProviderStatus({
        settings: defaultCopilotSettings,
        cwd: process.cwd(),
      });

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(snapshot.message, "401 Unauthorized");
      NodeAssert.equal(snapshot.usageLimits?.unavailable?.reason, "probeFailed");
    }),
  );

  it.effect("publishes account quotas without changing availability or the account label", () =>
    Effect.gen(function* () {
      runtimeMock.state.quotaResponse = {
        quotaSnapshots: {
          premium_interactions: {
            isUnlimitedEntitlement: false,
            entitlementRequests: 300,
            usedRequests: 320,
            usageAllowedWithExhaustedQuota: true,
            remainingPercentage: 0,
            overage: 20,
            overageAllowedWithExhaustedQuota: true,
            resetDate: "2026-10-01",
          },
        },
      };
      const snapshot = yield* checkCopilotProviderStatus({
        settings: defaultCopilotSettings,
        cwd: process.cwd(),
      });
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(snapshot.status, "warning"); // The mock reports no built-in models.
      NodeAssert.equal(snapshot.auth.status, "authenticated");
      NodeAssert.equal(snapshot.auth.label, "zortos293 (via gh)");
      NodeAssert.equal(snapshot.auth.email, undefined);
      NodeAssert.equal(snapshot.displayName, "GitHub Copilot");
      NodeAssert.deepEqual(snapshot.usageLimits?.windows, [
        {
          id: "copilot:premium_interactions:overage",
          kind: "monthly",
          label: "Premium requests · Overage allowed",
          usedPercent: 100,
          resetsAt: "2026-10-01T00:00:00.000Z",
        },
      ]);
      NodeAssert.deepEqual(runtimeMock.state.quotaCalls, [{}]);
    }),
  );

  it.effect("does not create a client or query quotas for a disabled provider", () =>
    Effect.gen(function* () {
      const settings = { ...defaultCopilotSettings, enabled: false };
      NodeAssert.equal(makePendingCopilotProvider(settings).usageLimits, undefined);
      const snapshot = yield* checkCopilotProviderStatus({ settings, cwd: process.cwd() });
      NodeAssert.equal(snapshot.status, "disabled");
      NodeAssert.equal(snapshot.usageLimits, undefined);
      NodeAssert.equal(runtimeMock.state.createCalls, 0);
      NodeAssert.deepEqual(runtimeMock.state.quotaCalls, []);
    }),
  );

  it.effect("clears unsupported account quotas without querying an unauthenticated account", () =>
    Effect.gen(function* () {
      runtimeMock.state.authenticated = false;
      runtimeMock.state.listModelsError = new Error("must not query unauthenticated models");
      const snapshot = yield* checkCopilotProviderStatus({
        settings: defaultCopilotSettings,
        cwd: process.cwd(),
      });
      NodeAssert.equal(snapshot.auth.status, "unauthenticated");
      NodeAssert.equal(snapshot.usageLimits?.unavailable?.reason, "unsupported");
      NodeAssert.deepEqual(runtimeMock.state.quotaCalls, []);
    }),
  );

  it.effect("keeps the provider usable when quota probing fails or is unsupported", () =>
    Effect.gen(function* () {
      runtimeMock.state.quotaError = new Error("quota service unavailable");
      const failed = yield* checkCopilotProviderStatus({
        settings: defaultCopilotSettings,
        cwd: process.cwd(),
      });
      NodeAssert.equal(failed.auth.status, "authenticated");
      NodeAssert.equal(failed.status, "warning");
      NodeAssert.equal(failed.usageLimits?.unavailable?.reason, "probeFailed");
      NodeAssert.doesNotMatch(failed.message ?? "", /quota service/);

      runtimeMock.state.quotaEndpointAvailable = false;
      const unsupported = yield* checkCopilotProviderStatus({
        settings: defaultCopilotSettings,
        cwd: process.cwd(),
      });
      NodeAssert.equal(unsupported.auth.status, "authenticated");
      NodeAssert.equal(unsupported.status, "warning");
      NodeAssert.equal(unsupported.usageLimits?.unavailable?.reason, "unsupported");
      NodeAssert.equal(runtimeMock.state.stopCalls, 2);
    }),
  );

  it.effect("returns an error snapshot when the configured Copilot CLI path is invalid", () =>
    Effect.gen(function* () {
      runtimeMock.state.createClientError = new Error(
        "The configured Copilot binary could not be found: /missing/copilot.",
      );

      const snapshot = yield* checkCopilotProviderStatus({
        settings: {
          ...defaultCopilotSettings,
          binaryPath: "/missing/copilot",
        },
        cwd: process.cwd(),
      });

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, false);
      NodeAssert.equal(
        snapshot.message,
        "The configured Copilot binary could not be started: /missing/copilot.",
      );
    }),
  );

  it.effect("timestamps each provider status check when the Effect executes", () =>
    Effect.gen(function* () {
      const statusCheck = checkCopilotProviderStatus({
        settings: defaultCopilotSettings,
        cwd: process.cwd(),
      });

      yield* TestClock.setTime(DateTime.makeUnsafe("2026-06-08T12:00:00.000Z").epochMilliseconds);
      const firstSnapshot = yield* statusCheck;

      yield* TestClock.adjust("1 minute");
      const secondSnapshot = yield* statusCheck;

      NodeAssert.equal(firstSnapshot.checkedAt, "2026-06-08T12:00:00.000Z");
      NodeAssert.equal(secondSnapshot.checkedAt, "2026-06-08T12:01:00.000Z");
    }),
  );

  it.effect("force stops the probe client when graceful cleanup is incomplete", () =>
    Effect.gen(function* () {
      runtimeMock.state.stopErrors = [new Error("probe runtime remained alive")];

      yield* checkCopilotProviderStatus({
        settings: defaultCopilotSettings,
        cwd: process.cwd(),
      });

      NodeAssert.equal(runtimeMock.state.stopCalls, 1);
      NodeAssert.equal(runtimeMock.state.forceStopCalls, 1);
    }),
  );
});
