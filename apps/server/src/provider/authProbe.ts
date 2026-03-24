export function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function extractAuthBoolean(value: unknown): boolean | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractAuthBoolean(entry);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["authenticated", "isAuthenticated", "loggedIn", "isLoggedIn"] as const) {
    if (typeof record[key] === "boolean") return record[key];
  }
  for (const key of ["auth", "status", "session", "account"] as const) {
    const nested = extractAuthBoolean(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export function extractPlanLabel(value: unknown): string | undefined {
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

export interface CommandJsonOutput {
  readonly stdout: string;
}

export function parseJsonOutput(result: CommandJsonOutput): unknown {
  const trimmed = result.stdout.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export function readAuthProbeDetails(result: CommandJsonOutput): {
  readonly attemptedJsonParse: boolean;
  readonly auth: boolean | undefined;
  readonly plan?: string;
} {
  const parsedJson = parseJsonOutput(result);
  const plan = extractPlanLabel(parsedJson);
  return {
    attemptedJsonParse: parsedJson !== undefined,
    auth: extractAuthBoolean(parsedJson),
    ...(plan ? { plan } : {}),
  };
}
