import { Schema } from "effect";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";
import { KeybindingRule, ResolvedKeybindingsConfig } from "./keybindings";
import { EditorId } from "./editor";
import { ProviderKind, ProviderStartOptions } from "./orchestration";

const KeybindingsMalformedConfigIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.malformed-config"),
  message: TrimmedNonEmptyString,
});

const KeybindingsInvalidEntryIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.invalid-entry"),
  message: TrimmedNonEmptyString,
  index: Schema.Number,
});

export const ServerConfigIssue = Schema.Union([
  KeybindingsMalformedConfigIssue,
  KeybindingsInvalidEntryIssue,
]);
export type ServerConfigIssue = typeof ServerConfigIssue.Type;

const ServerConfigIssues = Schema.Array(ServerConfigIssue);

export const ServerProviderStatusState = Schema.Literals(["ready", "warning", "error"]);
export type ServerProviderStatusState = typeof ServerProviderStatusState.Type;

export const ServerProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type ServerProviderAuthStatus = typeof ServerProviderAuthStatus.Type;

export const ServerProviderStatus = Schema.Struct({
  provider: ProviderKind,
  status: ServerProviderStatusState,
  available: Schema.Boolean,
  authStatus: ServerProviderAuthStatus,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
  plan: Schema.optional(TrimmedNonEmptyString),
  version: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderStatus = typeof ServerProviderStatus.Type;

const ServerProviderStatuses = Schema.Array(ServerProviderStatus);

export const ServerConfig = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
  providers: ServerProviderStatuses,
  availableEditors: Schema.Array(EditorId),
});
export type ServerConfig = typeof ServerConfig.Type;

export const ServerUpsertKeybindingInput = KeybindingRule;
export type ServerUpsertKeybindingInput = typeof ServerUpsertKeybindingInput.Type;

export const ServerUpsertKeybindingResult = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerUpsertKeybindingResult = typeof ServerUpsertKeybindingResult.Type;

export const ServerConfigUpdatedPayload = Schema.Struct({
  issues: ServerConfigIssues,
  providers: ServerProviderStatuses,
});
export type ServerConfigUpdatedPayload = typeof ServerConfigUpdatedPayload.Type;

export const ServerRefreshProviderStatusesResult = Schema.Struct({
  providers: ServerProviderStatuses,
});
export type ServerRefreshProviderStatusesResult = typeof ServerRefreshProviderStatusesResult.Type;

export const ServerRefreshProviderStatusesInput = Schema.Struct({
  providerOptions: Schema.optional(ProviderStartOptions),
});
export type ServerRefreshProviderStatusesInput = typeof ServerRefreshProviderStatusesInput.Type;

export const ServerRefreshProviderStatusInput = Schema.Struct({
  provider: ProviderKind,
  providerOptions: Schema.optional(ProviderStartOptions),
});
export type ServerRefreshProviderStatusInput = typeof ServerRefreshProviderStatusInput.Type;

export const ServerRefreshProviderStatusResult = Schema.Struct({
  providers: ServerProviderStatuses,
});
export type ServerRefreshProviderStatusResult = typeof ServerRefreshProviderStatusResult.Type;

export const ServerProviderAuthActionInput = Schema.Struct({
  provider: ProviderKind,
  providerOptions: Schema.optional(ProviderStartOptions),
});
export type ServerProviderAuthActionInput = typeof ServerProviderAuthActionInput.Type;

export const ServerProviderAuthActionResult = Schema.Struct({
  success: Schema.Boolean,
  message: Schema.optional(TrimmedNonEmptyString),
  providers: ServerProviderStatuses,
});
export type ServerProviderAuthActionResult = typeof ServerProviderAuthActionResult.Type;
