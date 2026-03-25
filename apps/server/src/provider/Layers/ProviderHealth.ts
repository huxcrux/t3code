/**
 * ProviderHealthLive - Startup-time provider health checks.
 *
 * Performs one-time provider readiness probes when the server starts and
 * keeps the resulting snapshot in memory for `server.getConfig`.
 *
 * Uses effect's ChildProcessSpawner to run CLI probes natively.
 *
 * @module ProviderHealthLive
 */
import * as OS from "node:os";
import type {
  ProviderStartOptions,
  ServerProviderAuthStatus,
  ServerProviderStatus,
  ServerProviderStatusState,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Option, Path, Ref, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { ProviderKind } from "@t3tools/contracts";

import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "../codexCliVersion";
import { nonEmptyTrimmed, readAuthProbeDetails } from "../authProbe";
import { readCodexAccountPlanViaAppServer } from "../codexAccount";
import {
  ProviderHealth,
  type ProviderAuthActionResult,
  type ProviderHealthShape,
} from "../Services/ProviderHealth";

const DEFAULT_TIMEOUT_MS = 4_000;
const CODEX_PROVIDER = "codex" as const;
const CLAUDE_AGENT_PROVIDER = "claudeAgent" as const;

const CLI_VERSION_PATTERN = /\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/;

// ── Pure helpers ────────────────────────────────────────────────────

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

interface ResolvedCommandConfig {
  readonly binaryPath: string;
  readonly env: NodeJS.ProcessEnv;
}

function isCommandMissingCause(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const lower = error.message.toLowerCase();
  return lower.includes("enoent") || lower.includes("notfound");
}

function detailFromResult(
  result: CommandResult & { readonly timedOut?: boolean },
): string | undefined {
  if (result.timedOut) return "Timed out while running command.";
  const stderr = nonEmptyTrimmed(result.stderr);
  if (stderr) return stderr;
  const stdout = nonEmptyTrimmed(result.stdout);
  if (stdout) return stdout;
  if (result.code !== 0) {
    return `Command exited with code ${result.code}.`;
  }
  return undefined;
}

export function parseAuthStatusFromOutput(result: CommandResult): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly message?: string;
  readonly plan?: string;
} {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      authStatus: "unknown",
      message: "Codex CLI authentication status command is unavailable in this Codex version.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `codex login`") ||
    lowerOutput.includes("run codex login")
  ) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }

  const parsedAuth = readAuthProbeDetails(result);

  if (parsedAuth.auth === true) {
    return {
      status: "ready",
      authStatus: "authenticated",
      ...(parsedAuth.plan ? { plan: parsedAuth.plan } : {}),
    };
  }
  if (parsedAuth.auth === false) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        "Could not verify Codex authentication status from JSON output (missing auth marker).",
    };
  }
  if (result.code === 0) {
    return {
      status: "ready",
      authStatus: "authenticated",
      ...(parsedAuth.plan ? { plan: parsedAuth.plan } : {}),
    };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    authStatus: "unknown",
    message: detail
      ? `Could not verify Codex authentication status. ${detail}`
      : "Could not verify Codex authentication status.",
  };
}

// ── Codex CLI config detection ──────────────────────────────────────

/**
 * Providers that use OpenAI-native authentication via `codex login`.
 * When the configured `model_provider` is one of these, the `codex login
 * status` probe still runs. For any other provider value the auth probe
 * is skipped because authentication is handled externally (e.g. via
 * environment variables like `PORTKEY_API_KEY` or `AZURE_API_KEY`).
 */
const OPENAI_AUTH_PROVIDERS = new Set(["openai"]);

/**
 * Read the `model_provider` value from the Codex CLI config file.
 *
 * Looks for the file at `$CODEX_HOME/config.toml` (falls back to
 * `~/.codex/config.toml`). Uses a simple line-by-line scan rather than
 * a full TOML parser to avoid adding a dependency for a single key.
 *
 * Returns `undefined` when the file does not exist or does not set
 * `model_provider`.
 */
export const readCodexConfigModelProvider = (options?: { readonly codexHomePath?: string }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const codexHome =
      options?.codexHomePath || process.env.CODEX_HOME || path.join(OS.homedir(), ".codex");
    const configPath = path.join(codexHome, "config.toml");

    const content = yield* fileSystem
      .readFileString(configPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (content === undefined) {
      return undefined;
    }

    // We need to find `model_provider = "..."` at the top level of the
    // TOML file (i.e. before any `[section]` header). Lines inside
    // `[profiles.*]`, `[model_providers.*]`, etc. are ignored.
    let inTopLevel = true;
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      // Skip comments and empty lines.
      if (!trimmed || trimmed.startsWith("#")) continue;
      // Detect section headers — once we leave the top level, stop.
      if (trimmed.startsWith("[")) {
        inTopLevel = false;
        continue;
      }
      if (!inTopLevel) continue;

      const match = trimmed.match(/^model_provider\s*=\s*["']([^"']+)["']/);
      if (match) return match[1];
    }
    return undefined;
  });

/**
 * Returns `true` when the Codex CLI is configured with a custom
 * (non-OpenAI) model provider, meaning `codex login` auth is not
 * required because authentication is handled through provider-specific
 * environment variables.
 */
const hasCustomModelProviderForOptions = (providerOptions?: ProviderStartOptions) =>
  Effect.map(
    readCodexConfigModelProvider(
      providerOptions?.codex?.homePath
        ? { codexHomePath: providerOptions.codex.homePath }
        : undefined,
    ),
    (provider) => provider !== undefined && !OPENAI_AUTH_PROVIDERS.has(provider),
  );
export const hasCustomModelProvider = hasCustomModelProviderForOptions();

// ── Effect-native command execution ─────────────────────────────────

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

function resolveCodexCommandConfig(providerOptions?: ProviderStartOptions): ResolvedCommandConfig {
  const binaryPath = providerOptions?.codex?.binaryPath ?? "codex";
  const homePath = providerOptions?.codex?.homePath;
  return {
    binaryPath,
    env: homePath ? { ...process.env, CODEX_HOME: homePath } : process.env,
  };
}

function resolveClaudeCommandConfig(providerOptions?: ProviderStartOptions): ResolvedCommandConfig {
  return {
    binaryPath: providerOptions?.claudeAgent?.binaryPath ?? "claude",
    env: process.env,
  };
}

const runCommand = (config: ResolvedCommandConfig, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make(config.binaryPath, [...args], {
      env: config.env,
      shell: process.platform === "win32",
    });

    const child = yield* spawner.spawn(command);

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

const runCodexCommand = (args: ReadonlyArray<string>, providerOptions?: ProviderStartOptions) =>
  runCommand(resolveCodexCommandConfig(providerOptions), args);

const runClaudeCommand = (args: ReadonlyArray<string>, providerOptions?: ProviderStartOptions) =>
  runCommand(resolveClaudeCommandConfig(providerOptions), args);

// ── Health check ────────────────────────────────────────────────────

export const makeCheckCodexProviderStatus = (
  providerOptions?: ProviderStartOptions,
): Effect.Effect<
  ServerProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();

    // Probe 1: `codex --version` — is the CLI reachable?
    const versionProbe = yield* runCodexCommand(["--version"], providerOptions).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return {
        provider: CODEX_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: isCommandMissingCause(error)
          ? "Codex CLI (`codex`) is not installed or not on PATH."
          : `Failed to execute Codex CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      };
    }

    if (Option.isNone(versionProbe.success)) {
      return {
        provider: CODEX_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Codex CLI is installed but failed to run. Timed out while running command.",
      };
    }

    const version = versionProbe.success.value;
    if (version.code !== 0) {
      const detail = detailFromResult(version);
      return {
        provider: CODEX_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Codex CLI is installed but failed to run. ${detail}`
          : "Codex CLI is installed but failed to run.",
      };
    }

    const parsedVersion = parseCodexCliVersion(`${version.stdout}\n${version.stderr}`);
    if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
      return {
        provider: CODEX_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: formatCodexCliUpgradeMessage(parsedVersion),
        ...(parsedVersion ? { version: parsedVersion } : {}),
      };
    }

    // Probe 2: `codex login status` — is the user authenticated?
    //
    // Custom model providers (e.g. Portkey, Azure OpenAI proxy) handle
    // authentication through their own environment variables, so `codex
    // login status` will report "not logged in" even when the CLI works
    // fine.  Skip the auth probe entirely for non-OpenAI providers.
    if (yield* hasCustomModelProviderForOptions(providerOptions)) {
      return {
        provider: CODEX_PROVIDER,
        status: "ready" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Using a custom Codex model provider; OpenAI login check skipped.",
        ...(parsedVersion ? { version: parsedVersion } : {}),
      } satisfies ServerProviderStatus;
    }

    const authProbe = yield* runCodexCommand(["login", "status"], providerOptions).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(authProbe)) {
      const error = authProbe.failure;
      return {
        provider: CODEX_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          error instanceof Error
            ? `Could not verify Codex authentication status: ${error.message}.`
            : "Could not verify Codex authentication status.",
        ...(parsedVersion ? { version: parsedVersion } : {}),
      };
    }

    if (Option.isNone(authProbe.success)) {
      return {
        provider: CODEX_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Could not verify Codex authentication status. Timed out while running command.",
        ...(parsedVersion ? { version: parsedVersion } : {}),
      };
    }

    const parsed = parseAuthStatusFromOutput(authProbe.success.value);
    const codexPlan =
      parsed.plan ??
      (parsed.authStatus === "authenticated"
        ? yield* readCodexAccountPlanViaAppServer(providerOptions?.codex)
        : undefined);
    return {
      provider: CODEX_PROVIDER,
      status: parsed.status,
      available: true,
      authStatus: parsed.authStatus,
      checkedAt,
      ...(parsed.message ? { message: parsed.message } : {}),
      ...(codexPlan ? { plan: codexPlan } : {}),
      ...(parsedVersion ? { version: parsedVersion } : {}),
    } satisfies ServerProviderStatus;
  });

export const checkCodexProviderStatus = makeCheckCodexProviderStatus();

// ── Claude Agent health check ───────────────────────────────────────

export function parseClaudeAuthStatusFromOutput(result: CommandResult): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly message?: string;
  readonly plan?: string;
} {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        "Claude Agent authentication status command is unavailable in this version of Claude.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `claude login`") ||
    lowerOutput.includes("run claude login")
  ) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
    };
  }

  // `claude auth status` returns JSON with a `loggedIn` boolean.
  const parsedAuth = readAuthProbeDetails(result);

  if (parsedAuth.auth === true) {
    return {
      status: "ready",
      authStatus: "authenticated",
      ...(parsedAuth.plan ? { plan: parsedAuth.plan } : {}),
    };
  }
  if (parsedAuth.auth === false) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        "Could not verify Claude authentication status from JSON output (missing auth marker).",
    };
  }
  if (result.code === 0) {
    return {
      status: "ready",
      authStatus: "authenticated",
      ...(parsedAuth.plan ? { plan: parsedAuth.plan } : {}),
    };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    authStatus: "unknown",
    message: detail
      ? `Could not verify Claude authentication status. ${detail}`
      : "Could not verify Claude authentication status.",
  };
}

export const makeCheckClaudeProviderStatus = (
  providerOptions?: ProviderStartOptions,
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();

    // Probe 1: `claude --version` — is the CLI reachable?
    const versionProbe = yield* runClaudeCommand(["--version"], providerOptions).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: isCommandMissingCause(error)
          ? "Claude Agent CLI (`claude`) is not installed or not on PATH."
          : `Failed to execute Claude Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      };
    }

    if (Option.isNone(versionProbe.success)) {
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      };
    }

    const version = versionProbe.success.value;
    if (version.code !== 0) {
      const detail = detailFromResult(version);
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Claude Agent CLI is installed but failed to run. ${detail}`
          : "Claude Agent CLI is installed but failed to run.",
      };
    }

    const claudeVersionMatch = CLI_VERSION_PATTERN.exec(`${version.stdout}\n${version.stderr}`);
    const claudeVersion = claudeVersionMatch?.[1] ?? undefined;

    // Probe 2: `claude auth status` — is the user authenticated?
    const authProbe = yield* runClaudeCommand(["auth", "status"], providerOptions).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(authProbe)) {
      const error = authProbe.failure;
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          error instanceof Error
            ? `Could not verify Claude authentication status: ${error.message}.`
            : "Could not verify Claude authentication status.",
        ...(claudeVersion ? { version: claudeVersion } : {}),
      };
    }

    if (Option.isNone(authProbe.success)) {
      return {
        provider: CLAUDE_AGENT_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Could not verify Claude authentication status. Timed out while running command.",
        ...(claudeVersion ? { version: claudeVersion } : {}),
      };
    }

    const parsed = parseClaudeAuthStatusFromOutput(authProbe.success.value);
    return {
      provider: CLAUDE_AGENT_PROVIDER,
      status: parsed.status,
      available: true,
      authStatus: parsed.authStatus,
      checkedAt,
      ...(parsed.message ? { message: parsed.message } : {}),
      ...(parsed.plan ? { plan: parsed.plan } : {}),
      ...(claudeVersion ? { version: claudeVersion } : {}),
    } satisfies ServerProviderStatus;
  });

export const checkClaudeProviderStatus = makeCheckClaudeProviderStatus();

// ── Auth action helpers ──────────────────────────────────────────────

const LOGIN_TIMEOUT_MS = 120_000;
const LOGOUT_TIMEOUT_MS = 10_000;

function loginArgs(provider: ProviderKind): {
  run: (
    args: ReadonlyArray<string>,
    providerOptions?: ProviderStartOptions,
  ) => ReturnType<typeof runCodexCommand>;
  args: ReadonlyArray<string>;
} {
  switch (provider) {
    case "codex":
      return { run: runCodexCommand, args: ["login"] };
    case "claudeAgent":
      return { run: runClaudeCommand, args: ["auth", "login"] };
  }
}

function logoutArgs(provider: ProviderKind): {
  run: (
    args: ReadonlyArray<string>,
    providerOptions?: ProviderStartOptions,
  ) => ReturnType<typeof runCodexCommand>;
  args: ReadonlyArray<string>;
} {
  switch (provider) {
    case "codex":
      return { run: runCodexCommand, args: ["logout"] };
    case "claudeAgent":
      return { run: runClaudeCommand, args: ["auth", "logout"] };
  }
}

function providerCheck(
  provider: ProviderKind,
  providerOptions?: ProviderStartOptions,
): Effect.Effect<
  ServerProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  switch (provider) {
    case CODEX_PROVIDER:
      return makeCheckCodexProviderStatus(providerOptions);
    case CLAUDE_AGENT_PROVIDER:
      return makeCheckClaudeProviderStatus(providerOptions);
  }
}

// ── Layer ───────────────────────────────────────────────────────────

export const ProviderHealthLive = Layer.effect(
  ProviderHealth,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const configuredProviderOptionsRef = yield* Ref.make<ProviderStartOptions | undefined>(
      undefined,
    );
    const runProviderChecks = (providerOptions?: ProviderStartOptions) =>
      Effect.all(
        [
          makeCheckCodexProviderStatus(providerOptions),
          makeCheckClaudeProviderStatus(providerOptions),
        ],
        {
          concurrency: "unbounded",
        },
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
    const resolveProviderOptions = (providerOptions?: ProviderStartOptions) =>
      providerOptions !== undefined
        ? Effect.succeed(providerOptions)
        : Ref.get(configuredProviderOptionsRef);
    const setProviderOptions = (providerOptions?: ProviderStartOptions) =>
      providerOptions !== undefined
        ? Ref.set(configuredProviderOptionsRef, providerOptions)
        : Effect.void;
    const initialStatuses: ReadonlyArray<ServerProviderStatus> = yield* runProviderChecks();
    const statusesRef = yield* Ref.make<ReadonlyArray<ServerProviderStatus>>(initialStatuses);

    const refreshAndStore = (providerOptions?: ProviderStartOptions) =>
      Effect.gen(function* () {
        yield* setProviderOptions(providerOptions);
        const effectiveProviderOptions = yield* resolveProviderOptions(providerOptions);
        const statuses = yield* runProviderChecks(effectiveProviderOptions);
        yield* Ref.set(statusesRef, statuses);
        return statuses;
      });
    const refreshStatusAndStore = (
      provider: ProviderKind,
      providerOptions?: ProviderStartOptions,
    ) =>
      Effect.gen(function* () {
        yield* setProviderOptions(providerOptions);
        const effectiveProviderOptions = yield* resolveProviderOptions(providerOptions);
        const nextStatus = yield* providerCheck(provider, effectiveProviderOptions).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        return yield* Ref.modify(statusesRef, (currentStatuses) => {
          const providers = currentStatuses.map((status) =>
            status.provider === provider ? nextStatus : status,
          );
          return [providers, providers] as const;
        });
      });

    const runAuthAction = (
      provider: ProviderKind,
      getConfig: (p: ProviderKind) => ReturnType<typeof loginArgs>,
      timeoutMs: number,
      providerOptions?: ProviderStartOptions,
    ): Effect.Effect<ProviderAuthActionResult> =>
      Effect.gen(function* () {
        yield* setProviderOptions(providerOptions);
        const effectiveProviderOptions = yield* resolveProviderOptions(providerOptions);
        const { run, args } = getConfig(provider);
        const result = yield* run(args, effectiveProviderOptions).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.timeoutOption(timeoutMs),
          Effect.result,
        );

        if (Result.isFailure(result)) {
          const error = result.failure;
          const providers = yield* refreshAndStore(effectiveProviderOptions);
          return {
            success: false,
            message: error instanceof Error ? error.message : "Command failed.",
            providers,
          };
        }

        if (Option.isNone(result.success)) {
          const providers = yield* refreshAndStore(effectiveProviderOptions);
          return {
            success: false,
            message: "Command timed out.",
            providers,
          };
        }

        const cmd = result.success.value;
        const providers = yield* refreshAndStore(effectiveProviderOptions);
        return {
          success: cmd.code === 0,
          ...(cmd.code !== 0
            ? {
                message:
                  nonEmptyTrimmed(cmd.stderr) ??
                  nonEmptyTrimmed(cmd.stdout) ??
                  `Command exited with code ${cmd.code}.`,
              }
            : {}),
          providers,
        };
      });

    return {
      getStatuses: Ref.get(statusesRef),
      refreshStatuses: refreshAndStore,
      refreshStatus: refreshStatusAndStore,
      login: (provider: ProviderKind, providerOptions?: ProviderStartOptions) =>
        runAuthAction(provider, loginArgs, LOGIN_TIMEOUT_MS, providerOptions),
      logout: (provider: ProviderKind, providerOptions?: ProviderStartOptions) =>
        runAuthAction(provider, logoutArgs, LOGOUT_TIMEOUT_MS, providerOptions),
    } satisfies ProviderHealthShape;
  }),
);
