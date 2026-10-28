import type { CopilotClient, ModelInfo } from "@github/copilot-sdk";
import type { ServerProvider, ServerProviderSkill } from "@t3tools/contracts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  type ProviderProbeResult,
} from "@t3tools/provider-core/server/snapshotProbe";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as HttpClient from "effect/http/HttpClient";

import type { CopilotSettings } from "../settings.ts";
import {
  authFromCopilotStatus,
  buildCopilotClientOptions,
  COPILOT_PROVIDER,
  defaultCreateCopilotClient,
  modelsFromCopilotSdk,
  stopCopilotClient,
  trimOrUndefined,
  tryCopilot,
  usageLimitsFromCopilotQuota,
  type CreateCopilotClient,
} from "./runtime.ts";

export const COPILOT_PRESENTATION = {
  displayName: "GitHub Copilot",
  showInteractionModeToggle: true,
  reportsContextWindow: true,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
} as const;

const PROBE_TIMEOUT = "30 seconds";

export const buildInitialCopilotProviderSnapshot = Effect.fn("buildInitialCopilotProviderSnapshot")(
  function* (settings: CopilotSettings) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      models: modelsFromCopilotSdk([], settings.customModels),
      slashCommands: settings.enabled ? [COMPACT_SLASH_COMMAND] : [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking GitHub Copilot CLI availability..."
          : "GitHub Copilot is disabled in T3 Code settings.",
      },
    });
  },
);

export function skillsFromCopilotSdk(
  result: Awaited<ReturnType<CopilotClient["rpc"]["skills"]["discover"]>>,
): ReadonlyArray<ServerProviderSkill> {
  return result.skills.flatMap((skill) => {
    const name = trimOrUndefined(skill.commandName) ?? trimOrUndefined(skill.name);
    const path = trimOrUndefined(skill.path);
    if (!name || !path) return [];
    const description = trimOrUndefined(skill.description);
    return [
      {
        name,
        path,
        enabled: skill.enabled,
        userInvocable: skill.userInvocable,
        ...(description ? { description } : {}),
        scope: skill.source,
      },
    ];
  });
}

export function formatCopilotProbeError(cause: unknown): {
  readonly installed: boolean;
  readonly message: string;
} {
  const message =
    (cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "").trim() ||
    "GitHub Copilot status check failed.";
  const lower = message.toLowerCase();
  const missing = ["enoent", "was not found", "could not be found", "not executable"].some(
    (needle) => lower.includes(needle),
  );
  return { installed: !missing, message };
}

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  settings: CopilotSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  createClient: CreateCopilotClient = defaultCreateCopilotClient,
) {
  if (!settings.enabled) return yield* buildInitialCopilotProviderSnapshot(settings);
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const snapshot = (
    probe: ProviderProbeResult,
    models: ReadonlyArray<ModelInfo> = [],
    skills: ReadonlyArray<ServerProviderSkill> = [],
  ) =>
    buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: modelsFromCopilotSdk(models, settings.customModels),
      slashCommands: [COMPACT_SLASH_COMMAND],
      skills,
      probe,
    });
  const failed = (cause: unknown, version: string | null = null) => {
    const failure = formatCopilotProbeError(cause);
    return snapshot({
      installed: failure.installed,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: failure.message,
    });
  };

  const probe = Effect.acquireUseRelease(
    buildCopilotClientOptions({ settings, environment, cwd }).pipe(
      Effect.map((options) => createClient(options)),
    ),
    (client) =>
      Effect.gen(function* () {
        const [status, authStatus] = yield* tryCopilot(
          "Failed to start GitHub Copilot.",
          async () => {
            await client.start();
            return Promise.all([client.getStatus(), client.getAuthStatus()]);
          },
        );
        const version = trimOrUndefined(status.version) ?? null;
        const auth = authFromCopilotStatus(authStatus);
        if (!authStatus.isAuthenticated) {
          return snapshot({ installed: true, version, ...auth });
        }
        const [models, skills, usageLimits] = yield* Effect.all(
          [
            tryCopilot("Failed to list GitHub Copilot models.", () => client.listModels()).pipe(
              Effect.result,
            ),
            tryCopilot("Failed to discover Copilot skills.", () =>
              client.rpc.skills.discover({ projectPaths: [cwd] }),
            ).pipe(
              Effect.map(skillsFromCopilotSdk),
              Effect.orElseSucceed(() => []),
            ),
            tryCopilot("Failed to read Copilot quota.", () => client.rpc.account.getQuota({})).pipe(
              Effect.map((quota) => usageLimitsFromCopilotQuota(quota, checkedAt)),
              Effect.option,
            ),
          ],
          { concurrency: "unbounded" },
        );
        if (Result.isFailure(models)) {
          return snapshot(
            {
              installed: true,
              version,
              status: "error",
              auth: auth.auth,
              message: models.failure.detail,
            },
            [],
            skills,
          );
        }
        const hasModels = models.success.length > 0;
        return snapshot(
          {
            installed: true,
            version,
            auth: auth.auth,
            ...(Option.isSome(usageLimits) ? { usageLimits: usageLimits.value } : {}),
            ...(hasModels
              ? { status: "ready" as const }
              : {
                  status: "warning" as const,
                  message: "GitHub Copilot did not report any available models for this account.",
                }),
          },
          models.success,
          skills,
        );
      }).pipe(
        Effect.timeoutOption(PROBE_TIMEOUT),
        Effect.map(
          Option.getOrElse(() => failed(new Error("GitHub Copilot status check timed out."), null)),
        ),
      ),
    (client) => stopCopilotClient(client),
  );
  return yield* probe.pipe(Effect.catch((cause) => Effect.succeed(failed(cause))));
});

export const enrichCopilotSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<
  void,
  never,
  HttpClient.HttpClient | ProviderLatestVersions.ProviderLatestVersions
> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.flatMap(input.publishSnapshot),
    Effect.catchCause((cause) =>
      Effect.logWarning("Copilot version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
        driver: COPILOT_PROVIDER,
      }),
    ),
    Effect.asVoid,
  );
