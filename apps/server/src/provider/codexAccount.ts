import { Effect, Exit, Option, Ref, Schema, Stream } from "effect";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import type { ProviderStartOptions } from "@t3tools/contracts";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { extractPlanLabel } from "./authProbe";

export type CodexPlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "team"
  | "business"
  | "enterprise"
  | "edu"
  | "unknown";

export interface CodexAccountSnapshot {
  readonly type: "apiKey" | "chatgpt" | "unknown";
  readonly planType: CodexPlanType | null;
  readonly sparkEnabled: boolean;
}

const CODEX_SPARK_DISABLED_PLAN_TYPES = new Set<CodexPlanType>(["free", "go", "plus"]);
const APP_SERVER_PROBE_TIMEOUT_MS = 4_000;
const APP_SERVER_INITIALIZE_REQUEST_ID = 1;
const APP_SERVER_ACCOUNT_READ_REQUEST_ID = 2;
const APP_SERVER_REQUEST_ENCODER = new TextEncoder();
const AppServerInitializeRequestSchema = Schema.Struct({
  id: Schema.Literal(APP_SERVER_INITIALIZE_REQUEST_ID),
  method: Schema.Literal("initialize"),
  params: Schema.Struct({
    clientInfo: Schema.Struct({
      name: Schema.String,
      title: Schema.String,
      version: Schema.String,
    }),
    capabilities: Schema.Struct({
      experimentalApi: Schema.Boolean,
    }),
  }),
});

const AppServerInitializedNotificationSchema = Schema.Struct({
  method: Schema.Literal("initialized"),
});

const AppServerAccountReadRequestSchema = Schema.Struct({
  id: Schema.Literal(APP_SERVER_ACCOUNT_READ_REQUEST_ID),
  method: Schema.Literal("account/read"),
  params: Schema.Struct({}),
});

const AppServerResponseSchema = Schema.Struct({
  id: Schema.Union([Schema.Number, Schema.String]),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});

const encodeAppServerInitializeRequest = Schema.encodeSync(
  Schema.fromJsonString(AppServerInitializeRequestSchema),
);
const encodeAppServerInitializedNotification = Schema.encodeSync(
  Schema.fromJsonString(AppServerInitializedNotificationSchema),
);
const encodeAppServerAccountReadRequest = Schema.encodeSync(
  Schema.fromJsonString(AppServerAccountReadRequestSchema),
);
const decodeAppServerResponse = Schema.decodeUnknownExit(
  Schema.fromJsonString(AppServerResponseSchema),
);

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function hasAppServerError(value: unknown): boolean {
  return value != null;
}

function isCodexPlanType(value: string): value is CodexPlanType {
  switch (value) {
    case "free":
    case "go":
    case "plus":
    case "pro":
    case "team":
    case "business":
    case "enterprise":
    case "edu":
    case "unknown":
      return true;
    default:
      return false;
  }
}

function readCodexPlanType(value: Record<string, unknown>): CodexPlanType | null {
  const planType = asString(value.planType) ?? asString(value.plan_type);
  if (!planType) {
    return null;
  }
  return isCodexPlanType(planType) ? planType : "unknown";
}

export function readCodexAccountSnapshot(response: unknown): CodexAccountSnapshot {
  const record = asObject(response);
  const account = asObject(record?.account) ?? record;
  if (!account) {
    return {
      type: "unknown",
      planType: null,
      sparkEnabled: true,
    };
  }
  const accountType = asString(account?.type);

  if (accountType === "apiKey") {
    return {
      type: "apiKey",
      planType: null,
      sparkEnabled: true,
    };
  }

  if (accountType === "chatgpt") {
    const planType = readCodexPlanType(account) ?? "unknown";
    return {
      type: "chatgpt",
      planType,
      sparkEnabled: planType !== "unknown" && !CODEX_SPARK_DISABLED_PLAN_TYPES.has(planType),
    };
  }

  return {
    type: "unknown",
    planType: null,
    sparkEnabled: true,
  };
}

export function resolveCodexModelForAccount(
  model: string | undefined,
  account: CodexAccountSnapshot,
): string | undefined {
  if (model !== "gpt-5.3-codex-spark" || account.sparkEnabled) {
    return model;
  }

  return "gpt-5.3-codex";
}

export function buildCodexInitializeParams() {
  return {
    clientInfo: {
      name: "t3code_desktop",
      title: "T3 Code Desktop",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  } as const;
}

export function extractCodexAccountPlan(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const record = response as Record<string, unknown>;
  return extractPlanLabel(record.result ?? response);
}

export function readCodexAccountPlanViaAppServer(
  codexOptions?: ProviderStartOptions["codex"],
): Effect.Effect<string | undefined, never, ChildProcessSpawner.ChildProcessSpawner> {
  const messages = [
    APP_SERVER_REQUEST_ENCODER.encode(
      `${encodeAppServerInitializeRequest({
        id: APP_SERVER_INITIALIZE_REQUEST_ID,
        method: "initialize",
        params: buildCodexInitializeParams(),
      })}\n`,
    ),
    APP_SERVER_REQUEST_ENCODER.encode(
      `${encodeAppServerInitializedNotification({ method: "initialized" })}\n`,
    ),
    APP_SERVER_REQUEST_ENCODER.encode(
      `${encodeAppServerAccountReadRequest({
        id: APP_SERVER_ACCOUNT_READ_REQUEST_ID,
        method: "account/read",
        params: {},
      })}\n`,
    ),
  ] as const;

  const program: Effect.Effect<
    string | undefined,
    Error | PlatformError.PlatformError,
    ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  > = Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(codexOptions?.binaryPath ?? "codex", ["app-server"], {
        env: codexOptions?.homePath
          ? { ...process.env, CODEX_HOME: codexOptions.homePath }
          : process.env,
        shell: process.platform === "win32",
      }),
    );
    const planRef = yield* Ref.make<string | undefined>(undefined);

    const readPlan = Stream.decodeText(child.stdout).pipe(
      Stream.splitLines,
      Stream.runForEachWhile((line) =>
        Effect.gen(function* () {
          const decoded = decodeAppServerResponse(line);
          if (Exit.isFailure(decoded)) {
            return true;
          }

          const record = decoded.value;
          if (record.id === APP_SERVER_INITIALIZE_REQUEST_ID) {
            if (hasAppServerError(record.error)) {
              return yield* Effect.fail(new Error("Codex app-server initialize failed."));
            }
            return true;
          }
          if (record.id !== APP_SERVER_ACCOUNT_READ_REQUEST_ID) {
            return true;
          }

          yield* Ref.set(
            planRef,
            hasAppServerError(record.error) ? undefined : extractCodexAccountPlan(record),
          );
          return false;
        }),
      ),
      Effect.flatMap(() => Ref.get(planRef)),
    );

    return yield* Effect.gen(function* () {
      yield* Effect.forkScoped(Stream.runDrain(child.stderr).pipe(Effect.ignore));
      yield* Effect.forkScoped(
        Stream.run(Stream.fromIterable(messages), child.stdin).pipe(Effect.ignore),
      );
      return yield* readPlan;
    }).pipe(Effect.ensuring(child.kill().pipe(Effect.ignore)));
  });

  return program.pipe(
    Effect.scoped,
    Effect.timeoutOption(APP_SERVER_PROBE_TIMEOUT_MS),
    Effect.map((result) => (Option.isSome(result) ? result.value : undefined)),
    Effect.orElseSucceed(() => undefined),
  );
}
