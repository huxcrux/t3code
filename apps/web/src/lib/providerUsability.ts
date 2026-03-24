import { type ProviderKind, type ServerProviderStatus } from "@t3tools/contracts";

type ProviderUsabilityState = "usable" | "disabled" | "notFound" | "unauthenticated";

function providerDisplayName(provider: ProviderKind): string {
  switch (provider) {
    case "claudeAgent":
      return "Claude";
    case "codex":
    default:
      return "Codex";
  }
}

export function getProviderUsabilityState(
  status: ServerProviderStatus | null | undefined,
  enabledBySettings: boolean,
): ProviderUsabilityState {
  if (!enabledBySettings) return "disabled";
  if (!status) return "usable";
  if (!status.available) return "notFound";
  if (status.authStatus === "unauthenticated") return "unauthenticated";
  return "usable";
}

export function isProviderUsable(
  status: ServerProviderStatus | null | undefined,
  enabledBySettings: boolean,
): boolean {
  return getProviderUsabilityState(status, enabledBySettings) === "usable";
}

export function getProviderIssueLabel(
  status: ServerProviderStatus | null | undefined,
  enabledBySettings: boolean,
): string | null {
  switch (getProviderUsabilityState(status, enabledBySettings)) {
    case "disabled":
      return "Disabled";
    case "notFound":
      return "Not found";
    case "unauthenticated":
      return "Unauthed";
    case "usable":
    default:
      return null;
  }
}

export function getProviderUsabilityIssue(
  provider: ProviderKind,
  status: ServerProviderStatus | null | undefined,
  enabledBySettings: boolean,
): string | null {
  switch (getProviderUsabilityState(status, enabledBySettings)) {
    case "disabled":
      return `${providerDisplayName(provider)} is disabled in Settings. Re-enable it to start a turn.`;
    case "notFound":
      return `${providerDisplayName(provider)} was not found. Install it or check your PATH.`;
    case "unauthenticated":
      return `${providerDisplayName(provider)} is not authenticated. Run its login command to authenticate.`;
    case "usable":
    default:
      return null;
  }
}
