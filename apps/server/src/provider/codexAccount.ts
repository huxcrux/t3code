function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

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
  readonly email?: string;
  readonly planType: CodexPlanType | null;
  readonly sparkEnabled: boolean;
}

const CODEX_SPARK_DISABLED_PLAN_TYPES = new Set<CodexPlanType>(["free", "go", "plus"]);

export function readCodexAccountSnapshot(response: unknown): CodexAccountSnapshot {
  const record = asObject(response);
  const account = asObject(record?.account) ?? record;
  const accountType = asString(account?.type);
  const email = asString(account?.email)?.trim() || undefined;

  if (accountType === "apiKey") {
    return {
      type: "apiKey",
      ...(email ? { email } : {}),
      planType: null,
      sparkEnabled: true,
    };
  }

  if (accountType === "chatgpt") {
    const planType = (account?.planType as CodexPlanType | null) ?? "unknown";
    return {
      type: "chatgpt",
      ...(email ? { email } : {}),
      planType,
      sparkEnabled: !CODEX_SPARK_DISABLED_PLAN_TYPES.has(planType),
    };
  }

  return {
    type: "unknown",
    ...(email ? { email } : {}),
    planType: null,
    sparkEnabled: true,
  };
}
