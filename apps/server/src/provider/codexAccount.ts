import { spawn } from "node:child_process";
import readline from "node:readline";

import { Effect, Option } from "effect";

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

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractPlanLabel(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractPlanLabel(entry);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["planType", "subscriptionType", "plan", "subscription"] as const) {
    const candidate = nonEmptyTrimmed(typeof record[key] === "string" ? record[key] : undefined);
    if (candidate !== undefined) return candidate;
  }
  for (const key of ["auth", "status", "session", "account"] as const) {
    const nested = extractPlanLabel(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
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

export function readCodexAccountPlanViaAppServer(): Effect.Effect<string | undefined, never> {
  return Effect.tryPromise(
    () =>
      new Promise<string | undefined>((resolve, reject) => {
        const child = spawn("codex", ["app-server"], {
          stdio: ["pipe", "pipe", "ignore"],
          shell: process.platform === "win32",
        });
        const output = readline.createInterface({ input: child.stdout });
        let settled = false;
        let nextId = 1;

        const cleanup = () => {
          output.close();
          if (!child.killed) {
            child.kill();
          }
        };

        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        const succeed = (plan: string | undefined) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(plan);
        };

        const sendMessage = (message: unknown) => {
          child.stdin.write(`${JSON.stringify(message)}\n`);
        };

        output.on("line", (line) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            return;
          }
          if (!parsed || typeof parsed !== "object") return;
          const record = parsed as Record<string, unknown>;
          const id =
            typeof record.id === "number" || typeof record.id === "string" ? record.id : null;
          if (id === 1) {
            if (record.error && typeof record.error === "object") {
              fail(new Error("Codex app-server initialize failed."));
              return;
            }
            sendMessage({ method: "initialized" });
            sendMessage({ id: nextId, method: "account/read", params: {} });
            nextId += 1;
            return;
          }
          if (id === 2) {
            if (record.error && typeof record.error === "object") {
              succeed(undefined);
              return;
            }
            succeed(extractCodexAccountPlan(record));
          }
        });

        child.once("error", (error) => fail(error));
        child.once("exit", (code) => {
          if (settled) return;
          fail(
            new Error(
              `Codex app-server exited before account data was available (code ${code ?? "unknown"}).`,
            ),
          );
        });

        sendMessage({
          id: nextId,
          method: "initialize",
          params: buildCodexInitializeParams(),
        });
        nextId += 1;
      }),
  ).pipe(
    Effect.timeoutOption(APP_SERVER_PROBE_TIMEOUT_MS),
    Effect.map((result) => (Option.isSome(result) ? result.value : undefined)),
    Effect.orElseSucceed(() => undefined),
  );
}
