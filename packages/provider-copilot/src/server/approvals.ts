import type {
  PermissionHandler,
  PermissionRequest,
  PermissionRequestResult,
  SessionConfig,
} from "@github/copilot-sdk";
import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderRequestKind,
  RuntimeMode,
} from "@t3tools/contracts";

import { trimOrUndefined } from "./runtime.ts";

type PromptRequest = Parameters<PermissionHandler>[1]["promptRequest"];
export type UserInputRequest = Parameters<NonNullable<SessionConfig["onUserInputRequest"]>>[0];
type UserInputResponse = Awaited<ReturnType<NonNullable<SessionConfig["onUserInputRequest"]>>>;

export const APPROVE_ONCE = { kind: "approve-once" } satisfies PermissionRequestResult;
export const REJECT = { kind: "reject" } satisfies PermissionRequestResult;
export const USER_NOT_AVAILABLE = { kind: "user-not-available" } satisfies PermissionRequestResult;

function managedApprovalRequired(request: PermissionRequest, promptRequest: PromptRequest) {
  if (
    promptRequest &&
    "managedApprovalRequired" in promptRequest &&
    typeof promptRequest.managedApprovalRequired === "boolean"
  ) {
    return promptRequest.managedApprovalRequired;
  }
  return request.managedApprovalRequired === true;
}

/** Requests T3 answers itself; they never reach the client. */
export function permissionAutoApproved(
  runtimeMode: RuntimeMode,
  request: PermissionRequest,
  promptRequest: PromptRequest,
): boolean {
  if (managedApprovalRequired(request, promptRequest)) return false;
  switch (runtimeMode) {
    case "full-access":
      return true;
    case "auto":
      return (
        promptRequest !== undefined &&
        "assistedApproval" in promptRequest &&
        promptRequest.assistedApproval?.recommendation === "approve"
      );
    case "auto-accept-edits":
      return request.kind === "write";
    case "approval-required":
      return false;
  }
}

export function permissionRequestKind(request: PermissionRequest): ProviderRequestKind {
  switch (request.kind) {
    case "shell":
      return "command";
    case "read":
      return "file-read";
    case "write":
      return "file-change";
    default:
      return "permission";
  }
}

export function permissionPrompt(request: PermissionRequest): string {
  const join = (...parts: ReadonlyArray<string | undefined>) =>
    parts
      .map((part) => trimOrUndefined(part))
      .filter(Boolean)
      .join(" ");
  const detail = (() => {
    switch (request.kind) {
      case "shell":
        return trimOrUndefined(request.fullCommandText) ?? trimOrUndefined(request.intention);
      case "write":
        return trimOrUndefined(request.fileName) ?? trimOrUndefined(request.intention);
      case "read":
        return trimOrUndefined(request.path) ?? trimOrUndefined(request.intention);
      case "mcp":
        return (
          trimOrUndefined(request.toolTitle) ??
          `${trimOrUndefined(request.serverDisplayName) ?? request.serverName}:${request.toolName}`
        );
      case "url":
        return trimOrUndefined(request.url) ?? trimOrUndefined(request.intention);
      case "memory":
        return trimOrUndefined(request.subject);
      case "custom-tool":
        return trimOrUndefined(request.toolName) ?? trimOrUndefined(request.toolDescription);
      case "hook":
        return trimOrUndefined(request.hookMessage) ?? trimOrUndefined(request.toolName);
      case "workflow":
        return trimOrUndefined(request.description);
      case "extension-management":
        return join(request.operation, request.extensionName);
      case "extension-permission-access":
        return join(request.extensionName, ...request.capabilities);
      case "extension-env-access":
        return join(request.extensionName, ...request.environmentVariables);
    }
  })();
  return detail ?? `GitHub Copilot requests ${request.kind} permission`;
}

/** Copilot can remember these approvals for the session; others are once-only. */
function sessionApproval(
  request: PermissionRequest,
  promptRequest: PromptRequest,
): PermissionRequestResult | undefined {
  switch (request.kind) {
    case "shell": {
      if (!request.canOfferSessionApproval) return undefined;
      const identifiers = (
        promptRequest?.kind === "commands"
          ? promptRequest.commandIdentifiers
          : request.commands.map((command) => command.identifier)
      )
        .map((identifier: string) => identifier.trim())
        .filter(Boolean);
      return identifiers.length > 0
        ? {
            kind: "approve-for-session",
            approval: { kind: "commands", commandIdentifiers: identifiers },
          }
        : undefined;
    }
    case "write":
      return request.canOfferSessionApproval
        ? { kind: "approve-for-session", approval: { kind: "write" } }
        : undefined;
    case "read":
      return { kind: "approve-for-session", approval: { kind: "read" } };
    case "mcp":
      return {
        kind: "approve-for-session",
        approval: { kind: "mcp", serverName: request.serverName, toolName: request.toolName },
      };
    case "url": {
      try {
        const domain = new URL(request.url).hostname.trim();
        return domain ? { kind: "approve-for-session", domain } : undefined;
      } catch {
        return undefined;
      }
    }
    case "memory":
      return { kind: "approve-for-session", approval: { kind: "memory" } };
    case "custom-tool":
      return {
        kind: "approve-for-session",
        approval: { kind: "custom-tool", toolName: request.toolName },
      };
    default:
      return undefined;
  }
}

export function permissionOptions(
  request: PermissionRequest,
  promptRequest: PromptRequest,
): ReadonlyArray<ProviderApprovalOption> {
  return [
    { decision: "accept", label: "Allow once" },
    ...(sessionApproval(request, promptRequest)
      ? [{ decision: "acceptForSession" as const, label: "Allow for this session" }]
      : []),
    { decision: "decline", label: "Deny" },
  ];
}

export function permissionResult(
  request: PermissionRequest,
  promptRequest: PromptRequest,
  decision: ProviderApprovalDecision | undefined,
  feedback: string | undefined,
): PermissionRequestResult {
  switch (decision) {
    case "accept":
      return APPROVE_ONCE;
    case "acceptForSession":
    case "acceptAlways":
      return sessionApproval(request, promptRequest) ?? APPROVE_ONCE;
    case "cancel":
      return USER_NOT_AVAILABLE;
    default: {
      const text = trimOrUndefined(feedback);
      return text ? { kind: "reject", feedback: text } : REJECT;
    }
  }
}

export const USER_INPUT_QUESTION_ID = "answer";

/** T3 answers arrive keyed by question id; Copilot takes one answer per request. */
export function userInputResponse(
  request: UserInputRequest,
  answers: Readonly<Record<string, unknown>> | undefined,
): UserInputResponse {
  const raw = answers?.[USER_INPUT_QUESTION_ID] ?? Object.values(answers ?? {})[0];
  const value = Array.isArray(raw) ? raw.find((entry) => typeof entry === "string") : raw;
  const answer = typeof value === "string" ? value.trim() : "";
  const choices = request.choices ?? [];
  return { answer, wasFreeform: !choices.includes(answer) };
}
