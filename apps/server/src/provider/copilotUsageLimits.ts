import type { CopilotClient } from "@github/copilot-sdk";
import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { ServerProviderShape } from "./Services/ServerProvider.ts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
  resolveUsageLimitsAfterProbe,
} from "./providerUsageLimits.ts";

const optionalNumber = Schema.optionalKey(Schema.NullOr(Schema.Number));
const optionalBoolean = Schema.optionalKey(Schema.NullOr(Schema.Boolean));
const optionalString = Schema.optionalKey(Schema.NullOr(Schema.String));

// The public experimental account.getQuota RPC normalizes these fields. Also
// accept the raw Copilot user-response quota_snapshots at this boundary.
const QuotaResponse = Schema.Struct({
  quotaSnapshots: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  quota_snapshots: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  quota_reset_date_utc: optionalString,
  quota_reset_date: optionalString,
  limited_user_reset_date: optionalString,
});
const QuotaSnapshot = Schema.Struct({
  isUnlimitedEntitlement: optionalBoolean,
  entitlementRequests: optionalNumber,
  usedRequests: optionalNumber,
  usageAllowedWithExhaustedQuota: optionalBoolean,
  remainingPercentage: optionalNumber,
  overage: optionalNumber,
  overageAllowedWithExhaustedQuota: optionalBoolean,
  resetDate: optionalString,
  unlimited: optionalBoolean,
  entitlement: optionalNumber,
  percent_remaining: optionalNumber,
  remaining: optionalNumber,
  quota_remaining: optionalNumber,
  has_quota: optionalBoolean,
  quota_reset_at: optionalNumber,
  overage_count: optionalNumber,
  overage_permitted: optionalBoolean,
});
const decodeResponse = Schema.decodeUnknownOption(QuotaResponse);
const decodeSnapshot = Schema.decodeUnknownOption(QuotaSnapshot);
const decodeRpcError = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.Number }));

const QUOTA_LABELS: Readonly<Record<string, string>> = {
  premium_interactions: "Premium requests",
  chat: "Chat",
  completions: "Completions",
};

function finite(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isoFromString(value: string | null | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim();
  // The raw API also returns calendar dates and zone-less ISO timestamps.
  // Interpret those in UTC, not in the server machine's local timezone.
  const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(trimmed)
    ? `${trimmed}Z`
    : trimmed;
  const date = DateTime.make(utc);
  return Option.isSome(date) ? DateTime.formatIso(date.value) : undefined;
}

function isoFromSeconds(value: number | null | undefined): string | undefined {
  const seconds = finite(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  const date = DateTime.make(seconds * 1_000);
  return Option.isSome(date) ? DateTime.formatIso(date.value) : undefined;
}

/** Full account read, never inferred from assistant.usage tokens or request cost. */
export function copilotQuotaResponseToLimits(input: {
  readonly response: unknown;
  readonly checkedAt: string;
}) {
  const { checkedAt } = input;
  const decoded = decodeResponse(input.response);
  if (Option.isNone(decoded)) {
    return makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" });
  }
  const response = decoded.value;
  const snapshots = response.quotaSnapshots ?? response.quota_snapshots;
  if (!snapshots) {
    return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  }
  const fallbackReset =
    isoFromString(response.quota_reset_date_utc) ??
    isoFromString(response.quota_reset_date) ??
    isoFromString(response.limited_user_reset_date);
  const windows: ServerProviderUsageWindow[] = [];
  for (const [id, raw] of Object.entries(snapshots)) {
    if (raw === null || raw === undefined) continue;
    const snapshot = decodeSnapshot(raw);
    if (Option.isNone(snapshot) || !id.trim() || id !== id.trim()) {
      return makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" });
    }
    const quota = snapshot.value;
    const entitlement = finite(quota.entitlementRequests) ?? finite(quota.entitlement);
    const unlimited =
      quota.isUnlimitedEntitlement === true || quota.unlimited === true || entitlement === -1;
    const overageAllowed =
      quota.usageAllowedWithExhaustedQuota === true ||
      quota.overageAllowedWithExhaustedQuota === true ||
      quota.overage_permitted === true;
    const remainingPercent = finite(quota.remainingPercentage) ?? finite(quota.percent_remaining);
    const remaining = finite(quota.remaining) ?? finite(quota.quota_remaining);
    const used = finite(quota.usedRequests);
    const usedPercent = unlimited
      ? 0
      : remainingPercent !== undefined
        ? clampPercent(100 - remainingPercent)
        : entitlement !== undefined && entitlement > 0 && remaining !== undefined
          ? clampPercent(100 - (remaining / entitlement) * 100)
          : entitlement !== undefined && entitlement > 0 && used !== undefined
            ? clampPercent((used / entitlement) * 100)
            : quota.has_quota === false || (entitlement === 0 && remaining === 0)
              ? 100
              : undefined;
    if (usedPercent === undefined) {
      // An unrecognized/malformed partial read must not erase the last good
      // account snapshot or invent zero usage for an unknown bucket.
      return makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" });
    }
    const label = Object.hasOwn(QUOTA_LABELS, id)
      ? QUOTA_LABELS[id]!
      : id.replaceAll("_", " ").trim() || id;
    const resetsAt = unlimited
      ? undefined
      : (isoFromSeconds(quota.quota_reset_at) ?? isoFromString(quota.resetDate) ?? fallbackReset);
    windows.push({
      // The pooled UI groups by id: do not average unlimited or overage-enabled
      // accounts into a hard entitlement, or inherit another account's label.
      id: `copilot:${id}${unlimited ? ":unlimited" : overageAllowed ? ":overage" : ""}`,
      kind: "monthly",
      label: unlimited
        ? `${label} · Unlimited`
        : overageAllowed
          ? `${label} · Overage allowed`
          : label,
      // This measures the included entitlement, not whether a turn is blocked.
      // In particular, 100% with overage allowed does not justify auto-switching.
      usedPercent,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return makeUsageLimits({ checkedAt, windows });
}

/** Structural so missing experimental RPCs on older runtimes are harmless. */
export interface CopilotQuotaClient {
  readonly rpc?: {
    readonly account?: {
      readonly getQuota?: (
        params: Parameters<CopilotClient["rpc"]["account"]["getQuota"]>[0],
      ) => Promise<unknown>;
    };
  };
}

/** Uses the connected client's existing account; never reads or supplies credentials. */
export const readCopilotUsageLimits = Effect.fn("readCopilotUsageLimits")(function* (
  client: CopilotQuotaClient,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* Effect.tryPromise(async () => {
    // Access inside tryPromise: the SDK's rpc getter throws before start().
    const account = client.rpc?.account;
    if (typeof account?.getQuota !== "function") {
      return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    }
    return copilotQuotaResponseToLimits({ response: await account.getQuota({}), checkedAt });
  }).pipe(
    Effect.timeout("4 seconds"),
    Effect.catch((error) => {
      const cause = error._tag === "UnknownError" ? error.cause : error;
      const rpcError = decodeRpcError(cause);
      const unsupported = Option.isSome(rpcError) && rpcError.value.code === -32601;
      return Effect.succeed(
        makeUnavailableUsageLimits({
          checkedAt,
          reason: unsupported ? "unsupported" : "probeFailed",
        }),
      );
    }),
  );
});

type Limits = ServerProvider["usageLimits"];

/** Per-instance sink, captured by the adapter's existing Effect runtime. */
export class CopilotUsageLimitsSink extends Context.Service<
  CopilotUsageLimitsSink,
  { readonly record: (limits: Limits) => Effect.Effect<void> }
>()("t3/provider/copilotUsageLimits/CopilotUsageLimitsSink") {}

/**
 * Call from the adapter on session start, usage, or a quota error. A successful
 * read replaces windows AND reset dates; transient failures retain the last
 * good read, while unsupported clears it. Without a driver sink this simply
 * returns the read (useful to standalone adapters/tests).
 */
export const refreshCopilotUsageLimits = Effect.fn("refreshCopilotUsageLimits")(function* (
  client: CopilotQuotaClient,
) {
  const limits = yield* readCopilotUsageLimits(client);
  const sink = yield* Effect.serviceOption(CopilotUsageLimitsSink);
  if (Option.isSome(sink)) yield* sink.value.record(limits);
  return limits;
});

/**
 * Copilot reads full account snapshots, unlike the shared sparse event merger.
 * Keep the replacement semantics local: otherwise unlimited/removed buckets
 * and reset dates would linger until the next status probe.
 */
export const makeCopilotUsageLimitsState = Effect.fn("makeCopilotUsageLimitsState")(function* () {
  const state = yield* SubscriptionRef.make<Limits>(undefined);
  let accountIdentity: string | undefined;
  const record = (probed: Limits) =>
    SubscriptionRef.update(state, (published) =>
      resolveUsageLimitsAfterProbe({ published, probed }),
    );
  const recordProbe = Effect.fn("recordCopilotProbeUsageLimits")(function* (probe: ServerProvider) {
    const identity =
      probe.auth.status === "authenticated"
        ? `${probe.auth.type ?? ""}:${probe.auth.label ?? ""}`
        : undefined;
    const accountChanged =
      identity !== undefined && accountIdentity !== undefined && identity !== accountIdentity;
    if (identity !== undefined) accountIdentity = identity;
    // Unknown auth on a failed probe is not a logout. A confirmed account
    // change, however, must not attach the old user's bars to the new label.
    yield* SubscriptionRef.update(state, (published) =>
      resolveUsageLimitsAfterProbe({
        published: accountChanged ? undefined : published,
        probed: probe.enabled ? probe.usageLimits : undefined,
      }),
    );
  });
  const apply = (snapshot: ServerProvider) =>
    SubscriptionRef.get(state).pipe(
      Effect.map((limits) => {
        const { usageLimits: _previous, ...rest } = snapshot;
        return limits === undefined ? rest : { ...rest, usageLimits: limits };
      }),
    );
  const wrap = (snapshot: ServerProviderShape): ServerProviderShape => ({
    ...snapshot,
    getSnapshot: snapshot.getSnapshot.pipe(Effect.flatMap(apply)),
    refresh: snapshot.refresh.pipe(Effect.flatMap(apply)),
    streamChanges: Stream.merge(
      snapshot.streamChanges,
      SubscriptionRef.changes(state).pipe(Stream.mapEffect(() => snapshot.getSnapshot)),
    ).pipe(Stream.mapEffect(apply), Stream.changes),
  });
  return { record, recordProbe, wrap };
});
