/**
 * ProviderHealth - Provider readiness snapshot service.
 *
 * Owns provider health checks (install/auth reachability) and exposes the
 * latest results to transport layers.
 *
 * @module ProviderHealth
 */
import type { ProviderKind, ServerProviderStatus } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface ProviderAuthActionResult {
  readonly success: boolean;
  readonly message?: string;
  readonly providers: ReadonlyArray<ServerProviderStatus>;
}

export interface ProviderHealthShape {
  /**
   * Read the latest provider health statuses.
   */
  readonly getStatuses: Effect.Effect<ReadonlyArray<ServerProviderStatus>>;

  /**
   * Re-run provider health probes and update the cached snapshot.
   */
  readonly refreshStatuses: Effect.Effect<ReadonlyArray<ServerProviderStatus>>;

  /**
   * Re-run provider health probes for a single provider and update the cached snapshot.
   */
  readonly refreshStatus: (
    provider: ProviderKind,
  ) => Effect.Effect<ReadonlyArray<ServerProviderStatus>>;

  /**
   * Run the login command for a provider and refresh statuses.
   */
  readonly login: (provider: ProviderKind) => Effect.Effect<ProviderAuthActionResult>;

  /**
   * Run the logout command for a provider and refresh statuses.
   */
  readonly logout: (provider: ProviderKind) => Effect.Effect<ProviderAuthActionResult>;
}

export class ProviderHealth extends ServiceMap.Service<ProviderHealth, ProviderHealthShape>()(
  "t3/provider/Services/ProviderHealth",
) {}
