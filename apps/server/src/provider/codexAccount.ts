import { Effect, Option, Ref, Stream } from "effect";
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
const encoder = new TextEncoder();

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function readCodexAccountSnapshot(response: unknown): CodexAccountSnapshot {
  const record = asObject(response);
  const account = asObject(record?.account) ?? record;
  const accountType = asString(account?.type);

  if (accountType === "apiKey") {
    return {
      type: "apiKey",
      planType: null,
      sparkEnabled: true,
    };
  }

  if (accountType === "chatgpt") {
    const planType = (account?.planType as CodexPlanType | null) ?? "unknown";
    return {
      type: "chatgpt",
      planType,
      sparkEnabled: !CODEX_SPARK_DISABLED_PLAN_TYPES.has(planType),
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

function encodeJsonRpcMessage(message: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(message)}\n`);
}

export function readCodexAccountPlanViaAppServer(): Effect.Effect<
  string | undefined,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const probeResultRef = yield* Ref.make<{ done: boolean; plan: string | undefined }>({
      done: false,
      plan: undefined,
    });
    const command = ChildProcess.make("codex", ["app-server"], {
      shell: process.platform === "win32",
      stdin: {
        stream: Stream.make(
          encodeJsonRpcMessage({
            id: APP_SERVER_INITIALIZE_REQUEST_ID,
            method: "initialize",
            params: buildCodexInitializeParams(),
          }),
          encodeJsonRpcMessage({ method: "initialized" }),
          encodeJsonRpcMessage({
            id: APP_SERVER_ACCOUNT_READ_REQUEST_ID,
            method: "account/read",
            params: {},
          }),
        ),
      },
    });

    yield* spawner.streamLines(command).pipe(
      Stream.runForEachWhile((line) =>
        Effect.gen(function* () {
          const parsed = (() => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })();
          const record = asObject(parsed);
          if (!record) return true;
          const id = record.id;
          if (id === APP_SERVER_INITIALIZE_REQUEST_ID) {
            if (record.error && typeof record.error === "object") {
              return yield* Effect.fail(new Error("Codex app-server initialize failed."));
            }
            return true;
          }
          if (id !== APP_SERVER_ACCOUNT_READ_REQUEST_ID) {
            return true;
          }
          yield* Ref.set(probeResultRef, {
            done: true,
            plan:
              record.error && typeof record.error === "object"
                ? undefined
                : extractCodexAccountPlan(record),
          });
          return false;
        }),
      ),
    );

    const probeResult = yield* Ref.get(probeResultRef);
    if (probeResult.done) {
      return probeResult.plan;
    }
    return yield* Effect.fail(
      new Error("Codex app-server exited before account data was available."),
    );
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(APP_SERVER_PROBE_TIMEOUT_MS),
    Effect.map((result) => (Option.isSome(result) ? result.value : undefined)),
    Effect.orElseSucceed(() => undefined),
  );
}
