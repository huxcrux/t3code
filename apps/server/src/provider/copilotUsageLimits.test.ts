import * as NodeAssert from "node:assert/strict";

import type { CopilotClient } from "@github/copilot-sdk";
import { describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderUsageLimits,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  CopilotUsageLimitsSink,
  copilotQuotaResponseToLimits,
  makeCopilotUsageLimitsState,
  readCopilotUsageLimits,
  refreshCopilotUsageLimits,
  type CopilotQuotaClient,
} from "./copilotUsageLimits.ts";
import type { ServerProviderShape } from "./Services/ServerProvider.ts";

const checkedAt = "2026-09-11T12:00:00.000Z";
const isUsageLimits = Schema.is(ServerProviderUsageLimits);
const reset = "2026-10-01T00:00:00.000Z";
type QuotaResult = Awaited<ReturnType<CopilotClient["rpc"]["account"]["getQuota"]>>;
const sdkQuota = {
  isUnlimitedEntitlement: false,
  entitlementRequests: 300,
  usedRequests: 75,
  usageAllowedWithExhaustedQuota: false,
  remainingPercentage: 75,
  overage: 0,
  overageAllowedWithExhaustedQuota: false,
  resetDate: reset,
} satisfies NonNullable<QuotaResult["quotaSnapshots"][string]>;

const quotaClient = (response: unknown): CopilotQuotaClient => ({
  rpc: { account: { getQuota: async () => response } },
});

const normalize = (response: unknown) => copilotQuotaResponseToLimits({ response, checkedAt });

function providerSnapshot(instanceId: string): ServerProviderShape {
  const snapshot: ServerProvider = {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("copilot"),
    displayName: "Work Copilot",
    enabled: true,
    installed: true,
    status: "ready",
    version: "1.0.69",
    checkedAt,
    auth: { status: "authenticated", type: "gh-cli", label: "GitHub CLI - @example" },
    models: [],
    slashCommands: [],
    skills: [],
  };
  return {
    getSnapshot: Effect.succeed(snapshot),
    refresh: Effect.succeed(snapshot),
    streamChanges: Stream.never,
    applyUsageLimits: () => Effect.void,
    resolveMaintenance: () => Effect.die("Not used by quota tests"),
  };
}

describe("copilotQuotaResponseToLimits", () => {
  it("normalizes the installed SDK's account.getQuota response", () => {
    const response = {
      quotaSnapshots: { premium_interactions: sdkQuota },
    } satisfies QuotaResult;
    const result = normalize(response);
    NodeAssert.deepEqual(result, {
      checkedAt,
      windows: [
        {
          id: "copilot:premium_interactions",
          kind: "monthly",
          label: "Premium requests",
          usedPercent: 25,
          resetsAt: reset,
        },
      ],
    });
    NodeAssert.equal(isUsageLimits(result), true);
  });

  it("normalizes raw quota_snapshots with stable ids and count fallbacks", () => {
    const result = normalize({
      quota_reset_date: "2026-10-01",
      quota_snapshots: {
        premium_interactions: { percent_remaining: 60, entitlement: 300, remaining: 0 },
        chat: { entitlement: 50, remaining: 10 },
        completions: { entitlement: 2_000, quota_remaining: 1_500 },
        future_quota: { percent_remaining: 30 },
        absent: null,
      },
    });
    NodeAssert.deepEqual(
      result.windows.map((window) => [window.id, window.usedPercent]),
      [
        ["copilot:chat", 80],
        ["copilot:completions", 25],
        ["copilot:future_quota", 70],
        ["copilot:premium_interactions", 40],
      ],
    );
    NodeAssert.equal(
      result.windows.every((window) => window.resetsAt === reset),
      true,
    );
    NodeAssert.equal(result.windows[2]?.label, "future quota");
    NodeAssert.equal(isUsageLimits(result), true);
  });

  it("uses SDK request counts when the experimental percentage is absent", () => {
    const { remainingPercentage: _percentage, ...quota } = sdkQuota;
    NodeAssert.equal(
      normalize({ quotaSnapshots: { premium_interactions: quota } }).windows[0]?.usedPercent,
      25,
    );
  });

  it("clamps finite percentages without interpreting overage counts as entitlement", () => {
    const result = normalize({
      quota_snapshots: {
        chat: { percent_remaining: 120, overage_count: 40 },
        premium_interactions: { percent_remaining: -20, overage_count: 2 },
        completions: { has_quota: false },
      },
    });
    NodeAssert.deepEqual(
      result.windows.map((window) => window.usedPercent),
      [0, 100, 100],
    );
  });

  it("shows unlimited as available even with sentinel/zero quota and a past reset", () => {
    const result = normalize({
      quota_snapshots: {
        chat: { entitlement: -1, percent_remaining: 0, has_quota: false, quota_reset_at: 1 },
        completions: { unlimited: true, remaining: 0, entitlement: 0 },
      },
    });
    NodeAssert.equal(result.windows.length, 2);
    for (const window of result.windows) {
      NodeAssert.equal(window.usedPercent, 0);
      NodeAssert.match(window.label, /Unlimited/);
      NodeAssert.equal(window.resetsAt, undefined);
    }
  });

  it("shows included usage with an overage label, not a blocking or switching signal", () => {
    const result = normalize({
      quotaSnapshots: {
        chat: { ...sdkQuota, remainingPercentage: 0, usageAllowedWithExhaustedQuota: true },
        premium_interactions: {
          ...sdkQuota,
          remainingPercentage: 0,
          overage: 20,
          overageAllowedWithExhaustedQuota: true,
        },
      },
    });
    for (const window of result.windows) {
      NodeAssert.equal(window.usedPercent, 100);
      NodeAssert.match(window.label, /Overage allowed/);
    }
    NodeAssert.match(
      normalize({
        quota_snapshots: {
          chat: { remaining: 0, entitlement: 0, has_quota: false, overage_permitted: true },
        },
      }).windows[0]!.label,
      /Overage allowed/,
    );
  });

  it("keeps unlimited, overage-enabled, and enforced quotas in distinct UI pools", () => {
    const quotaWindow = (quota: unknown) =>
      normalize({ quotaSnapshots: { chat: quota } }).windows[0]!;
    const enforced = quotaWindow(sdkQuota);
    const unlimited = quotaWindow({ ...sdkQuota, isUnlimitedEntitlement: true });
    const overage = quotaWindow({ ...sdkQuota, overageAllowedWithExhaustedQuota: true });
    NodeAssert.equal(new Set([enforced.id, unlimited.id, overage.id]).size, 3);
    NodeAssert.notEqual(enforced.label, overage.label);
    NodeAssert.notEqual(enforced.label, unlimited.label);
  });

  it("prefers epoch-seconds bucket resets, then UTC account resets, then raw strings", () => {
    const result = normalize({
      quota_reset_date_utc: "2026-10-01T02:00:00+02:00",
      quota_reset_date: "2026-11-01",
      quota_snapshots: {
        chat: {
          percent_remaining: 50,
          quota_reset_at: Date.parse("2026-09-20T00:00:00Z") / 1_000,
        },
        completions: { percent_remaining: 50, quota_reset_at: -1 },
      },
    });
    NodeAssert.equal(result.windows[0]?.resetsAt, "2026-09-20T00:00:00.000Z");
    NodeAssert.equal(result.windows[1]?.resetsAt, reset);
    for (const raw of ["2026-10-01", "2026-10-01T00:00:00", "2026-10-01T00:00:00Z"]) {
      const limits = normalize({
        quota_reset_date_utc: "invalid",
        quota_reset_date: raw,
        quota_snapshots: { chat: { percent_remaining: 50 } },
      });
      NodeAssert.equal(limits.windows[0]?.resetsAt, reset);
    }
    NodeAssert.equal(
      normalize({
        limited_user_reset_date: "2026-10-01",
        quota_snapshots: { chat: { percent_remaining: 50 } },
      }).windows[0]?.resetsAt,
      reset,
    );
  });

  it("omits invalid resets and never advances a past reset or invents a monthly duration", () => {
    const result = normalize({
      quotaSnapshots: {
        chat: { ...sdkQuota, resetDate: "not a date" },
        completions: { ...sdkQuota, resetDate: "2025-10-01" },
      },
    });
    NodeAssert.equal(result.windows[0]?.resetsAt, undefined);
    NodeAssert.equal(result.windows[1]?.resetsAt, "2025-10-01T00:00:00.000Z");
    NodeAssert.equal(
      result.windows.some((window) => window.windowDurationMins !== undefined),
      false,
    );
  });

  it("distinguishes an empty full read, unavailable quota support, and invalid data", () => {
    NodeAssert.deepEqual(normalize({ quotaSnapshots: {} }), { checkedAt, windows: [] });
    NodeAssert.equal(normalize({}).unavailable?.reason, "unsupported");
    NodeAssert.equal(normalize({ quota_snapshots: null }).unavailable?.reason, "unsupported");
    for (const response of [
      null,
      { quotaSnapshots: [] },
      { quota_snapshots: { chat: {} } },
      { quota_snapshots: { chat: { percent_remaining: "0" } } },
      { quota_snapshots: { chat: { percent_remaining: Number.NaN } } },
      { quota_snapshots: { chat: { percent_remaining: Number.POSITIVE_INFINITY } } },
    ]) {
      NodeAssert.equal(normalize(response).unavailable?.reason, "probeFailed");
    }
  });
});

describe("Copilot quota RPC", () => {
  it.effect("calls only account.getQuota with empty parameters on the existing client", () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const client: CopilotQuotaClient = {
        rpc: {
          account: {
            getQuota: async (params) => {
              calls.push(params);
              return { quotaSnapshots: { premium_interactions: sdkQuota } } satisfies QuotaResult;
            },
          },
        },
      };
      const limits = yield* readCopilotUsageLimits(client);
      NodeAssert.deepEqual(calls, [{}]);
      NodeAssert.equal(limits.windows[0]?.usedPercent, 25);
    }),
  );

  it.effect("tolerates absent experimental endpoints and JSON-RPC method-not-found", () =>
    Effect.gen(function* () {
      const clients: CopilotQuotaClient[] = [
        {},
        { rpc: {} },
        { rpc: { account: {} } },
        {
          rpc: {
            account: {
              getQuota: async () => {
                throw Object.assign(new Error("Method not found"), { code: -32601 });
              },
            },
          },
        },
      ];
      for (const client of clients) {
        NodeAssert.equal(
          (yield* readCopilotUsageLimits(client)).unavailable?.reason,
          "unsupported",
        );
      }
    }),
  );

  it.effect("treats connection, transport, auth, and unrecognized RPC errors as failed reads", () =>
    Effect.gen(function* () {
      const disconnected: CopilotQuotaClient = {
        get rpc(): never {
          throw new Error("Client is not connected. Call start() first.");
        },
      };
      NodeAssert.equal(
        (yield* readCopilotUsageLimits(disconnected)).unavailable?.reason,
        "probeFailed",
      );
      for (const message of ["network unavailable", "401 Unauthorized", "403 Forbidden"]) {
        const client: CopilotQuotaClient = {
          rpc: {
            account: {
              getQuota: async () => {
                throw new Error(message);
              },
            },
          },
        };
        const limits = yield* readCopilotUsageLimits(client);
        NodeAssert.equal(limits.unavailable?.reason, "probeFailed");
        NodeAssert.equal(limits.unavailable?.message, undefined);
      }
    }),
  );

  it.effect("bounds a hung optional quota endpoint without failing provider availability", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const client: CopilotQuotaClient = {
        rpc: {
          account: {
            getQuota: () => {
              Deferred.doneUnsafe(started, Effect.void);
              return new Promise<unknown>(() => {});
            },
          },
        },
      };
      const fiber = yield* readCopilotUsageLimits(client).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("4 seconds");
      NodeAssert.equal((yield* Fiber.join(fiber)).unavailable?.reason, "probeFailed");
    }),
  );
});

describe("Copilot full runtime quota replacement", () => {
  it.effect("never retains another account's limits after confirmed reauthentication", () =>
    Effect.gen(function* () {
      const state = yield* makeCopilotUsageLimitsState();
      const base = yield* providerSnapshot("copilot-work").getSnapshot;
      const snapshot = state.wrap(providerSnapshot("copilot-work"));
      const good = normalize({ quotaSnapshots: { chat: sdkQuota } });
      yield* state.recordProbe({ ...base, usageLimits: good });
      const failed = normalize(null);
      yield* state.recordProbe({ ...base, auth: { status: "unknown" }, usageLimits: failed });
      NodeAssert.strictEqual((yield* snapshot.getSnapshot).usageLimits, good);
      yield* state.recordProbe({
        ...base,
        auth: { ...base.auth, label: "GitHub CLI - @another-account" },
        usageLimits: failed,
      });
      NodeAssert.strictEqual((yield* snapshot.getSnapshot).usageLimits, failed);
      yield* state.recordProbe({ ...base, enabled: false, usageLimits: good });
      NodeAssert.equal((yield* snapshot.getSnapshot).usageLimits, undefined);
    }),
  );

  it.effect(
    "retains good reads on failures but clears unsupported and authoritatively empty reads",
    () =>
      Effect.gen(function* () {
        const state = yield* makeCopilotUsageLimitsState();
        const snapshot = state.wrap(providerSnapshot("copilot-work"));
        const refresh = (response: unknown) =>
          refreshCopilotUsageLimits(quotaClient(response)).pipe(
            Effect.provideService(CopilotUsageLimitsSink, state),
          );
        yield* refresh({ quotaSnapshots: { premium_interactions: sdkQuota } });
        const good = (yield* snapshot.getSnapshot).usageLimits;
        yield* refresh({ quotaSnapshots: { premium_interactions: {} } });
        NodeAssert.strictEqual((yield* snapshot.getSnapshot).usageLimits, good);
        yield* refresh({});
        NodeAssert.equal(
          (yield* snapshot.getSnapshot).usageLimits?.unavailable?.reason,
          "unsupported",
        );
        yield* refresh({ quotaSnapshots: { premium_interactions: sdkQuota } });
        NodeAssert.equal((yield* snapshot.getSnapshot).usageLimits?.windows.length, 1);
        yield* refresh({ quotaSnapshots: {} });
        NodeAssert.deepEqual((yield* snapshot.getSnapshot).usageLimits?.windows, []);
        yield* state.record(undefined);
        NodeAssert.equal((yield* snapshot.getSnapshot).usageLimits, undefined);
      }),
  );

  it.effect("removes old reset dates and vanished windows without the shared sparse merger", () =>
    Effect.gen(function* () {
      const state = yield* makeCopilotUsageLimitsState();
      const snapshot = state.wrap(providerSnapshot("copilot-work"));
      yield* state.record(normalize({ quotaSnapshots: { chat: sdkQuota, completions: sdkQuota } }));
      const { resetDate: _resetDate, ...quota } = sdkQuota;
      yield* state.record(normalize({ quotaSnapshots: { chat: quota } }));
      const next = yield* snapshot.getSnapshot;
      NodeAssert.equal(next.usageLimits?.windows.length, 1);
      NodeAssert.equal(next.usageLimits?.windows[0]?.resetsAt, undefined);
      yield* state.record(
        normalize({
          quotaSnapshots: { chat: { ...sdkQuota, isUnlimitedEntitlement: true } },
        }),
      );
      NodeAssert.equal((yield* snapshot.getSnapshot).usageLimits?.windows[0]?.usedPercent, 0);
      NodeAssert.equal((yield* snapshot.getSnapshot).usageLimits?.windows[0]?.resetsAt, undefined);
    }),
  );

  it.effect(
    "publishes updates through the existing snapshot stream and preserves instance identity",
    () =>
      Effect.gen(function* () {
        const state = yield* makeCopilotUsageLimitsState();
        const otherState = yield* makeCopilotUsageLimitsState();
        const snapshot = state.wrap(providerSnapshot("copilot-work"));
        const other = otherState.wrap(providerSnapshot("copilot-personal"));
        const update = yield* Deferred.make<ServerProvider>();
        yield* snapshot.streamChanges.pipe(
          Stream.filter((next) => next.usageLimits?.windows.length === 1),
          Stream.take(1),
          Stream.runForEach((next) => Deferred.succeed(update, next)),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* refreshCopilotUsageLimits(quotaClient({ quotaSnapshots: { chat: sdkQuota } })).pipe(
          Effect.provideService(CopilotUsageLimitsSink, state),
        );
        const next = yield* Deferred.await(update);
        NodeAssert.equal(next.driver, "copilot");
        NodeAssert.equal(next.instanceId, "copilot-work");
        NodeAssert.equal(next.displayName, "Work Copilot");
        NodeAssert.equal(next.auth.label, "GitHub CLI - @example");
        NodeAssert.equal(next.auth.email, undefined);
        NodeAssert.equal((yield* other.getSnapshot).usageLimits, undefined);
        NodeAssert.deepEqual((yield* snapshot.refresh).usageLimits, next.usageLimits);
      }),
  );
});
