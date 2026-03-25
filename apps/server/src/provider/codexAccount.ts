import { spawn } from "node:child_process";
import readline from "node:readline";
import { Effect, Exit, Schema } from "effect";
import type { ProviderStartOptions } from "@t3tools/contracts";
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

function readCodexPlanType(value: Record<string, unknown>): CodexPlanType | null {
  const planType = asString(value.planType) ?? asString(value.plan_type);
  return (planType as CodexPlanType | undefined) ?? null;
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

export function readCodexAccountPlanViaAppServer(
  codexOptions?: ProviderStartOptions["codex"],
): Effect.Effect<string | undefined, never> {
  return Effect.promise(
    () =>
      new Promise<string | undefined>((resolve, reject) => {
        const child = spawn(codexOptions?.binaryPath ?? "codex", ["app-server"], {
          env: codexOptions?.homePath
            ? { ...process.env, CODEX_HOME: codexOptions.homePath }
            : process.env,
          shell: process.platform === "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
        let settled = false;
        const output = readline.createInterface({ input: child.stdout });
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          output.close();
          child.kill();
          resolve(undefined);
        }, APP_SERVER_PROBE_TIMEOUT_MS);

        const cleanup = () => {
          clearTimeout(timeout);
          output.close();
        };

        const finish = (plan: string | undefined) => {
          if (settled) return;
          settled = true;
          cleanup();
          child.kill();
          resolve(plan);
        };

        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          child.kill();
          reject(error);
        };

        child.once("error", fail);
        child.once("exit", () => finish(undefined));

        output.on("line", (line) => {
          const decoded = decodeAppServerResponse(line);
          if (Exit.isFailure(decoded)) return;
          const record = decoded.value;
          if (record.id === APP_SERVER_INITIALIZE_REQUEST_ID) {
            if (record.error && typeof record.error === "object") {
              fail(new Error("Codex app-server initialize failed."));
            }
            return;
          }
          if (record.id !== APP_SERVER_ACCOUNT_READ_REQUEST_ID) return;
          finish(
            record.error && typeof record.error === "object"
              ? undefined
              : extractCodexAccountPlan(record),
          );
        });

        child.stdin.write(
          `${encodeAppServerInitializeRequest({
            id: APP_SERVER_INITIALIZE_REQUEST_ID,
            method: "initialize",
            params: buildCodexInitializeParams(),
          })}\n`,
        );
        child.stdin.write(`${encodeAppServerInitializedNotification({ method: "initialized" })}\n`);
        child.stdin.write(
          `${encodeAppServerAccountReadRequest({
            id: APP_SERVER_ACCOUNT_READ_REQUEST_ID,
            method: "account/read",
            params: {},
          })}\n`,
        );
      }),
  ).pipe(Effect.orElseSucceed(() => undefined));
}
