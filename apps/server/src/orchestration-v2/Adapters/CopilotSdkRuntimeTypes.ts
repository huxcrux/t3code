/**
 * CopilotSdkRuntimeTypes — internal port for the GitHub Copilot SDK runtime.
 *
 * The v2 adapter owns orchestration semantics; this port isolates the lower-level
 * SDK session lifecycle so tests can exercise it without going through the full
 * orchestrator.
 *
 * @module CopilotSdkRuntimeTypes
 */
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
  ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

export class CopilotSdkRuntimeValidationError extends Schema.TaggedErrorClass<CopilotSdkRuntimeValidationError>()(
  "ProviderAdapterValidationError",
  {
    provider: Schema.String,
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter validation failed (${this.provider}) in ${this.operation}: ${this.issue}`;
  }
}

export class CopilotSdkRuntimeSessionNotFoundError extends Schema.TaggedErrorClass<CopilotSdkRuntimeSessionNotFoundError>()(
  "ProviderAdapterSessionNotFoundError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Unknown ${this.provider} adapter thread: ${this.threadId}`;
  }
}

export class CopilotSdkRuntimeSessionClosedError extends Schema.TaggedErrorClass<CopilotSdkRuntimeSessionClosedError>()(
  "ProviderAdapterSessionClosedError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.provider} adapter thread is closed: ${this.threadId}`;
  }
}

export class CopilotSdkRuntimeRequestError extends Schema.TaggedErrorClass<CopilotSdkRuntimeRequestError>()(
  "ProviderAdapterRequestError",
  {
    provider: Schema.String,
    method: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter request failed (${this.provider}) for ${this.method}: ${this.detail}`;
  }
}

export class CopilotSdkRuntimeProcessError extends Schema.TaggedErrorClass<CopilotSdkRuntimeProcessError>()(
  "ProviderAdapterProcessError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter process error (${this.provider}) for thread ${this.threadId}: ${this.detail}`;
  }
}

export type CopilotSdkRuntimeError =
  | CopilotSdkRuntimeValidationError
  | CopilotSdkRuntimeSessionNotFoundError
  | CopilotSdkRuntimeSessionClosedError
  | CopilotSdkRuntimeRequestError
  | CopilotSdkRuntimeProcessError;

/**
 * CopilotSdkRuntimePort — per-instance GitHub Copilot SDK runtime contract.
 */
export interface CopilotSdkRuntimePort {
  readonly provider: ProviderDriverKind;
  readonly capabilities: {
    readonly sessionModelSwitch: "in-session" | "unsupported";
  };
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, CopilotSdkRuntimeError>;
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, CopilotSdkRuntimeError>;
  readonly interruptTurn: (
    threadId: ThreadId,
    turnId?: TurnId,
  ) => Effect.Effect<void, CopilotSdkRuntimeError>;
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, CopilotSdkRuntimeError>;
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, CopilotSdkRuntimeError>;
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, CopilotSdkRuntimeError>;
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;
  readonly readThread: (threadId: ThreadId) => Effect.Effect<
    {
      readonly threadId: ThreadId;
      readonly turns: ReadonlyArray<{
        readonly id: TurnId;
        readonly items: ReadonlyArray<unknown>;
      }>;
    },
    CopilotSdkRuntimeError
  >;
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<
    {
      readonly threadId: ThreadId;
      readonly turns: ReadonlyArray<{
        readonly id: TurnId;
        readonly items: ReadonlyArray<unknown>;
      }>;
    },
    CopilotSdkRuntimeError
  >;
  readonly stopAll: () => Effect.Effect<void, CopilotSdkRuntimeError>;
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
