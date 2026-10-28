// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  CopilotClient,
  RuntimeConnection,
  type CopilotClientOptions,
  type CopilotSession,
  type GetAuthStatusResponse,
  type ModelInfo,
  type SessionConfig,
} from "@github/copilot-sdk";
import {
  ProviderDriverKind,
  type CustomModelSetting,
  type ModelCapabilities,
  type ModelSelection,
  type ProviderOptionDescriptor,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderState,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelCapabilities, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveCommandPath } from "@t3tools/shared/shell";
import { providerModelsFromSettings } from "@t3tools/provider-core/server/snapshotProbe";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { CopilotSettings } from "../settings.ts";

export const COPILOT_PROVIDER = ProviderDriverKind.make("copilot");

/** Injected by tests; production builds a real SDK client. */
export type CreateCopilotClient = (options: CopilotClientOptions) => CopilotClient;
export const defaultCreateCopilotClient: CreateCopilotClient = (options) =>
  new CopilotClient(options);

export class CopilotRuntimeError extends Schema.TaggedError<CopilotRuntimeError>()(
  "CopilotRuntimeError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const tryCopilot = <A>(detail: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new CopilotRuntimeError({ detail: copilotErrorDetail(detail, cause), cause }),
  });

function copilotErrorDetail(detail: string, cause: unknown): string {
  const message = cause instanceof Error ? cause.message.trim() : "";
  return message.length > 0 ? `${detail} ${message}` : detail;
}

export function trimOrUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

const POSIX_SHELL_CANDIDATES = ["/bin/bash", "/usr/bin/bash", "/bin/sh"] as const;

function isExecutableFile(path: string): boolean {
  try {
    if (!NodeFS.statSync(path).isFile()) return false;
    NodeFS.accessSync(path, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Copilot's shell tool rejects a missing or relative SHELL; fall back to a POSIX shell. */
export function normalizeCopilotEnvironment(
  input: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const env = { ...input };
  // The SDK prefers COPILOT_CLI_PATH over the connection we hand it.
  delete env.COPILOT_CLI_PATH;
  if (platform !== "win32") {
    const current = env.SHELL;
    const valid =
      current !== undefined &&
      !/\s/.test(current) &&
      NodePath.isAbsolute(current) &&
      isExecutableFile(current);
    if (!valid) {
      const fallback = POSIX_SHELL_CANDIDATES.find(isExecutableFile);
      if (fallback) env.SHELL = fallback;
    }
  }
  return env;
}

/** The SDK cannot spawn Windows npm shell shims; point it at npm's JS entry instead. */
export function resolveCopilotSdkExecutable(
  binaryPath: string,
  platform: NodeJS.Platform,
  isFile: (path: string) => boolean = isExecutableFile,
): string | undefined {
  if (platform !== "win32" || !/\.(cmd|bat|ps1)$/i.test(binaryPath)) return binaryPath;
  const directory = NodePath.win32.dirname(binaryPath);
  for (const entry of ["npm-loader.js", "index.js"]) {
    for (const root of ["node_modules", ".."]) {
      const candidate = NodePath.win32.join(directory, root, "@github", "copilot", entry);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

export const buildCopilotClientOptions = Effect.fn("buildCopilotClientOptions")(function* (input: {
  readonly settings: CopilotSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd?: string | undefined;
}) {
  const platform = yield* HostProcess.Platform;
  const env = normalizeCopilotEnvironment(input.environment, platform);
  const binaryPath = trimOrUndefined(input.settings.binaryPath) ?? "copilot";
  const resolved = yield* resolveCommandPath(binaryPath, { env });
  if (resolved === null) {
    return yield* new CopilotRuntimeError({
      detail: `GitHub Copilot CLI (${binaryPath}) was not found. Install it with \`npm install -g @github/copilot\` and run \`copilot login\` on this T3 server host.`,
    });
  }
  const executable = resolveCopilotSdkExecutable(resolved, platform);
  if (executable === undefined) {
    return yield* new CopilotRuntimeError({
      detail:
        "The Copilot launcher has no matching npm package entry. Reinstall with `npm install -g @github/copilot@latest` or select the native Copilot executable.",
    });
  }
  // The SDK otherwise runs JS launchers with process.execPath, which is Electron in desktop builds.
  let connection: CopilotClientOptions["connection"];
  if (/\.[cm]?js$/i.test(executable)) {
    const node = yield* resolveCommandPath("node", { env });
    if (node === null) {
      return yield* new CopilotRuntimeError({
        detail:
          "Node.js is required to run the npm Copilot launcher. Install Node.js or configure a native Copilot executable.",
      });
    }
    connection = RuntimeConnection.forStdio({ path: node, args: [executable] });
  } else {
    connection = RuntimeConnection.forStdio({ path: executable });
  }
  return {
    connection,
    ...(input.cwd ? { workingDirectory: input.cwd } : {}),
    env,
    logLevel: "error",
  } satisfies CopilotClientOptions;
});

/** Stop gracefully, then force-stop if the SDK reports leftovers or hangs. */
export const stopCopilotClient = (client: Pick<CopilotClient, "stop" | "forceStop">) =>
  Effect.tryPromise(() => client.stop()).pipe(
    Effect.timeout("5 seconds"),
    Effect.flatMap((errors) =>
      errors.length === 0 ? Effect.void : Effect.tryPromise(() => client.forceStop()),
    ),
    Effect.catch(() => Effect.tryPromise(() => client.forceStop())),
    Effect.ignore,
  );

const CopilotModelOptions = Schema.Struct({
  reasoningEffort: Schema.optional(
    Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
  ),
  contextTier: Schema.optional(Schema.Literals(["default", "long_context"])),
});
const decodeModelOptions = Schema.decodeUnknownSync(CopilotModelOptions);

export function readCopilotModelOptions(selection: ModelSelection | undefined) {
  try {
    return decodeModelOptions({
      reasoningEffort: getModelSelectionStringOptionValue(selection, "reasoningEffort"),
      contextTier: getModelSelectionStringOptionValue(selection, "contextTier"),
    });
  } catch {
    return {};
  }
}

type ReasoningEffort = NonNullable<SessionConfig["reasoningEffort"]>;

const SESSION_REASONING_EFFORTS: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] satisfies ReadonlyArray<ReasoningEffort>);

/**
 * Model fields for `createSession`/`resumeSession`. Session config only accepts some efforts;
 * `needsSwitch` means the caller must apply the selection with `switchCopilotModel`.
 */
export function copilotSessionModelConfig(selection: ModelSelection) {
  const { reasoningEffort, contextTier } = readCopilotModelOptions(selection);
  const sessionEffort =
    reasoningEffort && SESSION_REASONING_EFFORTS.has(reasoningEffort)
      ? (reasoningEffort as ReasoningEffort)
      : undefined;
  return {
    config: {
      model: selection.model,
      ...(sessionEffort ? { reasoningEffort: sessionEffort } : {}),
      ...(contextTier ? { contextTier } : {}),
    } satisfies Pick<SessionConfig, "model" | "reasoningEffort" | "contextTier">,
    needsSwitch: reasoningEffort !== undefined && sessionEffort === undefined,
  };
}

/** `model.switchTo` supports "none" and reports switches that need compaction, unlike setModel. */
export const switchCopilotModel = (session: CopilotSession, selection: ModelSelection) =>
  tryCopilot("Failed to switch the Copilot model.", async () => {
    const options = readCopilotModelOptions(selection);
    const result = await session.rpc.model.switchTo({
      modelId: selection.model,
      reasoningEffort: options.reasoningEffort ?? null,
      contextTier: options.contextTier ?? "default",
    });
    if (
      result.confirmation ||
      result.persistenceError ||
      (result.status && ["cancelled", "failed", "rejected"].includes(result.status))
    ) {
      throw new Error(
        result.persistenceError ??
          result.message ??
          "Compact the conversation before switching Copilot models.",
      );
    }
  });

const REASONING_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

export const EMPTY_COPILOT_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}K`;
  return tokens.toLocaleString("en-US");
}

const positive = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

export function capabilitiesFromCopilotModel(
  model: Pick<
    ModelInfo,
    "capabilities" | "supportedReasoningEfforts" | "defaultReasoningEffort" | "billing"
  >,
): ModelCapabilities {
  const descriptors: Array<ProviderOptionDescriptor> = [];
  const reasoning = (model.supportedReasoningEfforts ?? []).map((effort) => ({
    id: effort,
    label: REASONING_LABELS[effort] ?? effort,
    ...(model.defaultReasoningEffort === effort ? { isDefault: true } : {}),
  }));
  if (reasoning.length > 0) {
    const current = reasoning.find((option) => option.isDefault)?.id;
    descriptors.push({
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: reasoning,
      ...(current ? { currentValue: current } : {}),
    });
  }
  const prices = model.billing?.tokenPrices;
  const longContextMax = positive(prices?.longContext?.contextMax);
  if (longContextMax !== undefined) {
    const defaultMax = positive(prices?.contextMax);
    const longWindow = positive(model.capabilities.limits?.max_context_window_tokens);
    descriptors.push({
      id: "contextTier",
      label: "Context Window",
      type: "select",
      options: [
        {
          id: "default",
          label: defaultMax ? formatTokenCount(defaultMax) : "Default",
          isDefault: true,
        },
        { id: "long_context", label: longWindow ? formatTokenCount(longWindow) : "Long Context" },
      ],
      currentValue: "default",
    });
  }
  return createModelCapabilities({ optionDescriptors: descriptors });
}

export function modelsFromCopilotSdk(
  models: ReadonlyArray<ModelInfo>,
  customModels: ReadonlyArray<CustomModelSetting>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const builtIn: Array<ServerProviderModel> = [];
  for (const model of models) {
    if (model.policy?.state === "disabled") continue;
    const slug = model.id.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    builtIn.push({
      slug,
      name: trimOrUndefined(model.name) ?? slug,
      isCustom: false,
      ...(slug === "auto" ? { isDefault: true } : {}),
      capabilities: capabilitiesFromCopilotModel(model),
    });
  }
  return providerModelsFromSettings(builtIn, customModels, EMPTY_COPILOT_MODEL_CAPABILITIES);
}

/** Context window for the selected model and tier, from the probed catalog. */
export function copilotContextWindowTokens(
  selection: ModelSelection,
  models: ReadonlyArray<ModelInfo>,
): number | undefined {
  const model = models.find((candidate) => candidate.id === selection.model);
  if (!model) return undefined;
  const tier = readCopilotModelOptions(selection).contextTier;
  if (tier === "long_context")
    return positive(model.capabilities.limits?.max_context_window_tokens);
  return (
    positive(model.billing?.tokenPrices?.contextMax) ??
    positive(model.capabilities.limits?.max_context_window_tokens)
  );
}

const AUTH_TYPE_LABELS: Partial<Record<string, string>> = {
  env: "Environment token",
  "gh-cli": "GitHub CLI",
  hmac: "HMAC key",
  "api-key": "API key",
};

export function authFromCopilotStatus(status: GetAuthStatusResponse): {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
} {
  const type = trimOrUndefined(status.authType);
  const label =
    [
      type ? AUTH_TYPE_LABELS[type] : undefined,
      status.login ? `@${status.login}` : undefined,
      trimOrUndefined(status.host)?.replace(/^https?:\/\//, ""),
    ]
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join(" - ") || undefined;
  if (!status.isAuthenticated) {
    return {
      status: "error",
      auth: { status: "unauthenticated", ...(type ? { type } : {}), ...(label ? { label } : {}) },
      message:
        trimOrUndefined(status.statusMessage) ??
        "GitHub Copilot is not authenticated. Run `copilot login` on this T3 server host.",
    };
  }
  return {
    status: "ready",
    auth: { status: "authenticated", ...(type ? { type } : {}), ...(label ? { label } : {}) },
  };
}

export function usageLimitsFromCopilotQuota(
  result: Awaited<ReturnType<CopilotClient["rpc"]["account"]["getQuota"]>>,
  checkedAt: string,
): ServerProviderUsageLimits {
  const entries = Object.entries(result.quotaSnapshots).flatMap(([id, quota]) =>
    quota ? [[id, quota] as const] : [],
  );
  const tokenBased = (quota: (typeof entries)[number][1]) =>
    "tokenBasedBilling" in quota && quota.tokenBasedBilling === true;
  const unlimited =
    entries.length > 0 && entries.every(([, quota]) => quota.isUnlimitedEntitlement);
  return {
    checkedAt,
    ...(unlimited
      ? {
          notice:
            "Copilot reports unlimited entitlement for this account; no finite allowance is available.",
        }
      : {}),
    windows: entries.flatMap(([id, quota]) => {
      if (quota.isUnlimitedEntitlement || !Number.isFinite(quota.remainingPercentage)) return [];
      const resetMs = quota.resetDate ? Date.parse(quota.resetDate) : NaN;
      return [
        {
          id,
          kind: "monthly" as const,
          label:
            id === "premium_interactions"
              ? tokenBased(quota)
                ? "AI credits"
                : "Premium requests"
              : id.replaceAll("_", " "),
          usedPercent: Math.max(0, Math.min(100, 100 - quota.remainingPercentage)),
          ...(Number.isFinite(resetMs)
            ? { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(resetMs)) }
            : {}),
        },
      ];
    }),
  };
}
