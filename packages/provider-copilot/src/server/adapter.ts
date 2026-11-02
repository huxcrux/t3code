import type {
  CopilotSession,
  ExitPlanModeRequest,
  MessageOptions,
  PermissionHandler,
  PermissionRequest,
  PermissionRequestResult,
  SessionConfig,
  SessionEvent,
  SessionEventPayload,
} from "@github/copilot-sdk";
import type {
  ModelSelection,
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ExecutionNode,
  OrchestrationV2PlanStep,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemStatus,
  PlanId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeMode,
  RuntimeRequestId,
  ServerProviderModel,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  isProviderNativeImageAttachment,
  providerMessageTextWithAttachmentPaths,
} from "@t3tools/provider-core/server/attachmentPrompt";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { t3OrchestrationSystemPrompt } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";

import type { CopilotSettings } from "../settings.ts";
import {
  APPROVE_ONCE,
  USER_INPUT_QUESTION_ID,
  USER_NOT_AVAILABLE,
  permissionAutoApproved,
  permissionOptions,
  permissionPrompt,
  permissionRequestKind,
  permissionResult,
  userInputResponse,
  type UserInputRequest,
} from "./approvals.ts";
import {
  COPILOT_PROVIDER,
  buildCopilotClientOptions,
  copilotSessionModelConfig,
  resolveCopilotModelSelection,
  defaultCreateCopilotClient,
  stopCopilotClient,
  switchCopilotModel,
  trimOrUndefined,
  tryCopilot,
  type CreateCopilotClient,
} from "./runtime.ts";
import {
  COPILOT_TOOLS_WITH_NATIVE_ROWS,
  copilotToolPresentation,
  type CopilotToolState,
} from "./toolPresentation.ts";

const CopilotProviderCapabilitiesV2 = {
  runtimePolicy: { enforcement: "native" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    // T3 answers Copilot permission prompts itself, so a new mode applies on the next request.
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: true,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: true,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: true,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "weak",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface CopilotAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: CopilotSettings;
  readonly environment: NodeJS.ProcessEnv;
  /** Latest probed catalog, used to fill option defaults the client left implicit. */
  readonly models?: Effect.Effect<ReadonlyArray<ServerProviderModel>>;
  readonly createClient?: CreateCopilotClient;
}

type PromptRequest = Parameters<PermissionHandler>[1]["promptRequest"];
type UserInputResponse = ReturnType<typeof userInputResponse>;
type TerminalStatus = "completed" | "cancelled" | "interrupted" | "failed";

/** Where items land: the root turn, or a subagent's child thread. */
interface Target {
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly rootNodeId: NodeId;
  readonly providerThreadId: ProviderThreadId | null;
  readonly providerTurnId: ProviderTurnId | null;
  readonly scope: string;
  readonly ordinals: Map<string, number>;
  readonly started: Map<string, DateTime.Utc>;
  nextOrdinal: number;
}

type Entry =
  | { readonly kind: "message"; readonly nativeId: string; text: string; streaming: boolean }
  | { readonly kind: "reasoning"; readonly nativeId: string; text: string; streaming: boolean }
  | {
      readonly kind: "tool";
      readonly nativeId: string;
      readonly target: Target;
      readonly hidden: boolean;
      tool: CopilotToolState;
      status: OrchestrationV2TurnItemStatus;
    };

interface Subagent {
  readonly toolCallId: string;
  readonly parentThreadId: ThreadId;
  readonly target: Target;
  readonly appThread: OrchestrationV2AppThread;
  readonly prompt: string;
  title: string;
  model: string | null;
  status: OrchestrationV2TurnItemStatus;
  result: string | null;
  resultPublished: boolean;
}

interface ActiveTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  providerTurn: OrchestrationV2ProviderTurn;
  readonly nativeId: string;
  readonly root: Target;
  readonly entries: Map<string, Entry>;
  readonly dirty: Set<string>;
  readonly subagents: Map<string, Subagent>;
  readonly done: Deferred.Deferred<void>;
  readonly compact: boolean;
  todoPlanId?: PlanId;
  /** A root user.message arrived, so idle/error events now belong to this turn. */
  consumed: boolean;
  flushScheduled: boolean;
  interruptRequested: boolean;
}

interface PendingRequest {
  readonly respond: (
    response: Pick<OrchestrationV2RuntimeRequest, "decision" | "answers">,
    feedback?: string,
  ) => void;
  readonly cancel: () => void;
  request: OrchestrationV2RuntimeRequest;
  node: OrchestrationV2ExecutionNode;
  item: OrchestrationV2TurnItem;
}

type Inbox =
  | { readonly type: "event"; readonly event: SessionEvent }
  | {
      readonly type: "permission";
      readonly request: PermissionRequest;
      readonly promptRequest: PromptRequest;
      readonly resolve: (result: PermissionRequestResult) => void;
    }
  | {
      readonly type: "question";
      readonly request: UserInputRequest;
      readonly resolve: (result: UserInputResponse) => void;
    }
  | { readonly type: "plan"; readonly request: ExitPlanModeRequest }
  | { readonly type: "settled"; readonly turn: ActiveTurn; readonly error?: unknown }
  | { readonly type: "flush"; readonly turn: ActiveTurn };

const nativeRef = (nativeId: string) => ({
  driver: COPILOT_PROVIDER,
  nativeId,
  strength: "strong" as const,
});
const weakRef = (nativeId: string) => ({ ...nativeRef(nativeId), strength: "weak" as const });

const EMPTY_USER_INPUT: UserInputResponse = { answer: "", wasFreeform: true };
const PLAN_SHOWN_FEEDBACK =
  "The plan is shown to the user in T3 Code. Stop now and wait for their next message.";
const USAGE_LIMIT_ERRORS = new Set(["quota", "rate_limit"]);
// Above Node's timer limit setTimeout fires immediately; this is ~24.8 days.
const UNBOUNDED_TURN_MS = 2_147_483_647;

const isSettled = (status: OrchestrationV2TurnItemStatus) =>
  status !== "running" && status !== "pending" && status !== "waiting";

function stringArgument(args: unknown, key: string): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? trimOrUndefined(value) : undefined;
}

function todoStepStatus(status: string | undefined): OrchestrationV2PlanStep["status"] {
  switch (status?.toLowerCase()) {
    case "done":
    case "completed":
    case "complete":
      return "completed";
    case "in_progress":
    case "in-progress":
    case "running":
      return "running";
    default:
      return "pending";
  }
}

/** Copilot ends a subagent's identity at the spawning `task` tool call. */
function eventOwner(event: SessionEvent): string | undefined {
  if (event.agentId) return event.agentId;
  const data = event.data as { readonly parentToolCallId?: unknown };
  return typeof data.parentToolCallId === "string" ? data.parentToolCallId : undefined;
}

function errorMessage(cause: unknown, fallback: string): string {
  const error = Cause.isCause(cause) ? Cause.squash(cause) : cause;
  if (error && typeof error === "object" && "detail" in error && typeof error.detail === "string")
    return error.detail;
  return error instanceof Error && error.message ? error.message : fallback;
}

export const makeCopilotAdapterV2 = Effect.fn("makeCopilotAdapterV2")(function* (
  options: CopilotAdapterV2Options,
) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const providerHost = yield* ProviderHost.ProviderHost;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const createClient = options.createClient ?? defaultCreateCopilotClient;
  const resolveSelection = (selection: ModelSelection) =>
    (options.models ?? Effect.succeed([])).pipe(
      Effect.map((models) => resolveCopilotModelSelection(selection, models)),
    );

  const protocolError = (detail: string, payload?: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: COPILOT_PROVIDER,
      detail,
      ...(payload === undefined ? {} : { payload }),
    });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: COPILOT_PROVIDER,
    getCapabilities: Effect.fn("CopilotAdapter.getCapabilities")(function () {
      return Effect.succeed(CopilotProviderCapabilitiesV2);
    }),
    planSelectionTransition: Effect.fn("CopilotAdapter.planSelectionTransition")(function () {
      return Effect.succeed(turnScopedSelectionTransition());
    }),
    openSession: Effect.fn("CopilotAdapterV2.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      if (!options.settings.enabled) return yield* protocolError("GitHub Copilot is disabled");
      const openError = (cause: unknown) =>
        new ProviderAdapter.ProviderAdapterOpenSessionError({
          driver: COPILOT_PROVIDER,
          providerSessionId: input.providerSessionId,
          cause,
        });
      const scope = yield* Effect.scope;
      const cwd = input.runtimePolicy.cwd ?? providerHost.paths.cwd;
      const environment = McpProviderSession.withAgentDeviceEnvironment(
        options.environment,
        yield* mcpSessions.read(input.threadId),
      );
      const clientOptions = yield* buildCopilotClientOptions({
        settings: options.settings,
        environment,
        cwd,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(openError),
      );
      const client = createClient(clientOptions);
      yield* Effect.addFinalizer(() => stopCopilotClient(client));
      yield* tryCopilot("Failed to start GitHub Copilot.", () => client.start()).pipe(
        Effect.mapError(openError),
      );

      const now = yield* DateTime.now;
      let providerSession: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: COPILOT_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model,
        capabilities: CopilotProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | Cause.Done
      >();
      const inbox = yield* Queue.unbounded<Inbox>();
      const commands = yield* Semaphore.make(1);
      const eventPermit = yield* Semaphore.make(1);
      let session: CopilotSession | undefined;
      let thread: OrchestrationV2ProviderThread | undefined;
      let active: ActiveTurn | undefined;
      let lastProviderTurn: OrchestrationV2ProviderTurn | undefined;
      let closed = false;
      let broken = false;
      let runtimeMode: RuntimeMode = input.runtimePolicy.runtimeMode;
      let appliedModel: string | undefined;
      const pending = new Map<RuntimeRequestId, PendingRequest>();
      let nextLocalId = 0;

      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);
      const offer = (entry: Inbox) => !closed && Queue.offerUnsafe(inbox, entry);
      const updateSession = Effect.fnUntraced(function* (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null = null,
      ) {
        providerSession = {
          ...providerSession,
          status,
          lastError,
          updatedAt: yield* DateTime.now,
        };
        yield* emit({
          type: "provider_session.updated",
          driver: COPILOT_PROVIDER,
          providerSession,
        });
      });
      const updateThread = Effect.fnUntraced(function* (
        patch: Partial<OrchestrationV2ProviderThread>,
      ) {
        if (!thread) return;
        thread = { ...thread, ...patch, updatedAt: yield* DateTime.now };
        yield* emit({
          type: "provider_thread.updated",
          driver: COPILOT_PROVIDER,
          providerThread: thread,
        });
      });
      const emitProviderTurn = (providerTurn: OrchestrationV2ProviderTurn) =>
        emit({
          type: "provider_turn.updated",
          driver: COPILOT_PROVIDER,
          threadId: thread?.appThreadId ?? input.threadId,
          providerTurn,
        });

      const baseItem = (target: Target, nativeId: string, time: DateTime.Utc) => {
        if (!target.ordinals.has(nativeId)) target.ordinals.set(nativeId, target.nextOrdinal++);
        if (!target.started.has(nativeId)) target.started.set(nativeId, time);
        const identity = `${target.scope}:${nativeId}`;
        return {
          id: idAllocator.derive.turnItemFromProviderItem({
            driver: COPILOT_PROVIDER,
            nativeItemId: identity,
          }),
          nodeId: idAllocator.derive.nodeFromProviderItem({
            driver: COPILOT_PROVIDER,
            nativeItemId: identity,
          }),
          threadId: target.threadId,
          runId: target.runId,
          providerThreadId: target.providerThreadId,
          providerTurnId: target.providerTurnId,
          nativeItemRef: nativeRef(nativeId),
          parentItemId: null,
          ordinal: target.ordinals.get(nativeId)!,
          startedAt: target.started.get(nativeId)!,
          updatedAt: time,
        };
      };
      const publishNode = (
        target: Target,
        base: ReturnType<typeof baseItem>,
        kind: OrchestrationV2ExecutionNode["kind"],
        status: OrchestrationV2TurnItemStatus,
        completedAt: DateTime.Utc | null,
      ) =>
        emit({
          type: "node.updated",
          driver: COPILOT_PROVIDER,
          node: {
            id: base.nodeId,
            threadId: target.threadId,
            runId: target.runId,
            parentNodeId: target.rootNodeId,
            rootNodeId: target.rootNodeId,
            kind,
            status,
            countsForRun: false,
            providerThreadId: target.providerThreadId,
            providerTurnId: target.providerTurnId,
            nativeItemRef: base.nativeItemRef,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: base.startedAt,
            completedAt,
          },
        });
      const publishSimpleItem = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        nativeId: string,
        item:
          | {
              readonly type: "compaction";
              readonly summary?: string;
              readonly beforeTokenCount?: number;
              readonly afterTokenCount?: number;
            }
          | { readonly type: "system_notice"; readonly message: string },
        status: OrchestrationV2TurnItemStatus,
        title: string | null,
      ) {
        const time = yield* DateTime.now;
        const base = baseItem(turn.root, nativeId, time);
        const completedAt = isSettled(status) ? time : null;
        yield* publishNode(turn.root, base, "system", status, completedAt);
        yield* emit({
          type: "turn_item.updated",
          driver: COPILOT_PROVIDER,
          turnItem:
            item.type === "compaction"
              ? { ...base, ...item, driver: COPILOT_PROVIDER, status, title, completedAt }
              : { ...base, ...item, status, title, completedAt },
        });
      });

      const publishEntry = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        entry: Entry,
        terminal?: OrchestrationV2TurnItemStatus,
      ) {
        const time = yield* DateTime.now;
        if (entry.kind === "tool") {
          const status = terminal && !isSettled(entry.status) ? terminal : entry.status;
          if (entry.hidden && status !== "failed") return;
          const completedAt = isSettled(status) ? time : null;
          const base = baseItem(entry.target, entry.nativeId, time);
          yield* publishNode(entry.target, base, "tool_call", status, completedAt);
          yield* emit({
            type: "turn_item.updated",
            driver: COPILOT_PROVIDER,
            turnItem: {
              ...base,
              status,
              completedAt,
              ...copilotToolPresentation(entry.tool, status),
            },
          });
          return;
        }
        const streaming = entry.streaming && terminal === undefined;
        const status: OrchestrationV2TurnItemStatus = streaming ? "running" : "completed";
        const completedAt = streaming ? null : time;
        const base = baseItem(turn.root, entry.nativeId, time);
        yield* publishNode(
          turn.root,
          base,
          entry.kind === "message" ? "assistant_message" : "reasoning",
          status,
          completedAt,
        );
        if (entry.kind === "reasoning") {
          yield* emit({
            type: "turn_item.updated",
            driver: COPILOT_PROVIDER,
            turnItem: {
              ...base,
              type: "reasoning",
              status,
              title: null,
              completedAt,
              text: entry.text,
              streaming,
            },
          });
          return;
        }
        const messageId = idAllocator.derive.messageFromProviderItem({
          driver: COPILOT_PROVIDER,
          nativeItemId: `${turn.root.scope}:${entry.nativeId}`,
        });
        const message: OrchestrationV2ConversationMessage = {
          id: messageId,
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          nodeId: base.nodeId,
          role: "assistant",
          text: entry.text,
          attachments: [],
          streaming,
          createdBy: "agent",
          creationSource: "provider",
          createdAt: base.startedAt,
          updatedAt: time,
        };
        yield* emit({ type: "message.updated", driver: COPILOT_PROVIDER, message });
        yield* emit({
          type: "turn_item.updated",
          driver: COPILOT_PROVIDER,
          turnItem: {
            ...base,
            type: "assistant_message",
            status,
            title: null,
            completedAt,
            messageId,
            text: entry.text,
            streaming,
          },
        });
      });
      const markDirty = Effect.fnUntraced(function* (turn: ActiveTurn, key: string) {
        turn.dirty.add(key);
        if (turn.flushScheduled) return;
        turn.flushScheduled = true;
        yield* Effect.sleep(50).pipe(
          Effect.andThen(Effect.sync(() => offer({ type: "flush", turn }))),
          Effect.forkIn(scope),
        );
      });
      const flush = Effect.fnUntraced(function* (turn: ActiveTurn) {
        turn.flushScheduled = false;
        for (const key of turn.dirty) {
          const entry = turn.entries.get(key);
          if (entry) yield* publishEntry(turn, entry);
        }
        turn.dirty.clear();
      });

      const publishSubagent = Effect.fnUntraced(function* (turn: ActiveTurn, sub: Subagent) {
        const time = yield* DateTime.now;
        const base = baseItem(turn.root, `task:${sub.toolCallId}`, time);
        const completedAt = isSettled(sub.status) ? time : null;
        const taskRef = nativeRef(sub.toolCallId);
        const subagent: OrchestrationV2Subagent = {
          id: base.nodeId,
          threadId: base.threadId,
          runId: base.runId,
          parentNodeId: turn.input.rootNodeId,
          origin: "provider_native",
          createdBy: "agent",
          driver: COPILOT_PROVIDER,
          providerInstanceId: options.instanceId,
          providerThreadId: base.providerThreadId,
          childThreadId: sub.target.threadId,
          nativeTaskRef: taskRef,
          prompt: sub.prompt,
          title: sub.title,
          model: sub.model,
          status: sub.status,
          result: sub.result,
          startedAt: base.startedAt,
          completedAt,
          updatedAt: time,
        };
        yield* emit({ type: "subagent.updated", driver: COPILOT_PROVIDER, subagent });
        yield* publishNode(
          turn.root,
          { ...base, nativeItemRef: taskRef },
          "subagent",
          sub.status,
          completedAt,
        );
        yield* emit({
          type: "turn_item.updated",
          driver: COPILOT_PROVIDER,
          turnItem: {
            ...base,
            nativeItemRef: taskRef,
            type: "subagent",
            status: sub.status,
            title: sub.title,
            completedAt,
            subagentId: subagent.id,
            origin: "provider_native",
            driver: COPILOT_PROVIDER,
            providerInstanceId: options.instanceId,
            childThreadId: sub.target.threadId,
            prompt: sub.prompt,
            result: sub.result,
          },
        });
        yield* emit({
          type: "node.updated",
          driver: COPILOT_PROVIDER,
          node: {
            id: sub.target.rootNodeId,
            threadId: sub.target.threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: sub.target.rootNodeId,
            kind: "root_turn",
            status: sub.status,
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: taskRef,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: sub.appThread.createdAt,
            completedAt,
          },
        });
        if (completedAt && sub.result?.trim() && !sub.resultPublished) {
          sub.resultPublished = true;
          yield* publishChildMessage(sub, "assistant", sub.result, time);
        }
      });
      const publishChildMessage = Effect.fnUntraced(function* (
        sub: Subagent,
        role: "user" | "assistant",
        text: string,
        time: DateTime.Utc,
      ) {
        const identity = `${sub.target.scope}:${role}`;
        const artifacts = makeSubagentConversationArtifacts({
          messageId: idAllocator.derive.messageFromProviderItem({
            driver: COPILOT_PROVIDER,
            nativeItemId: identity,
          }),
          ...(role === "user" ? { senderThreadId: sub.parentThreadId } : {}),
          turnItemId: idAllocator.derive.turnItemFromProviderItem({
            driver: COPILOT_PROVIDER,
            nativeItemId: identity,
          }),
          threadId: sub.target.threadId,
          rootNodeId: sub.target.rootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: weakRef(sub.toolCallId),
          role,
          text,
          ordinal: role === "user" ? 1 : sub.target.nextOrdinal++,
          now: time,
        });
        yield* emit({
          type: "message.updated",
          driver: COPILOT_PROVIDER,
          message: artifacts.message,
        });
        yield* emit({
          type: "turn_item.updated",
          driver: COPILOT_PROVIDER,
          turnItem: artifacts.turnItem,
        });
      });
      const startSubagent = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        data: SessionEventPayload<"tool.execution_start">["data"],
      ) {
        const time = yield* DateTime.now;
        const toolCallId = data.toolCallId;
        const prompt = stringArgument(data.arguments, "prompt") ?? "";
        const childThreadId = idAllocator.derive.threadFromProviderThread({
          driver: COPILOT_PROVIDER,
          providerInstanceId: options.instanceId,
          nativeThreadId: `${session?.sessionId ?? input.providerSessionId}:${toolCallId}`,
        });
        const scope = `${options.instanceId}:child:${session?.sessionId}:${toolCallId}`;
        const rootNodeId = idAllocator.derive.nodeFromProviderItem({
          driver: COPILOT_PROVIDER,
          nativeItemId: `${scope}:root`,
        });
        const title = subagentThreadTitle({
          parentTitle: turn.input.appThread.title,
          prompt,
          title:
            stringArgument(data.arguments, "description") ??
            stringArgument(data.arguments, "name") ??
            null,
          ordinal: turn.subagents.size + 1,
        });
        const parentNodeId = baseItem(turn.root, `task:${toolCallId}`, time).nodeId;
        const appThread = makeSubagentChildThread({
          parentThread: turn.input.appThread,
          childThreadId,
          parentNodeId,
          activeProviderThreadId: null,
          providerInstanceId: options.instanceId,
          modelSelection: turn.input.modelSelection,
          title,
          now: time,
          createdBy: "agent",
          creationSource: "provider",
        });
        const sub: Subagent = {
          toolCallId,
          parentThreadId: turn.input.threadId,
          target: {
            threadId: childThreadId,
            runId: null,
            rootNodeId,
            providerThreadId: null,
            providerTurnId: null,
            scope,
            ordinals: new Map(),
            started: new Map(),
            nextOrdinal: 2,
          },
          appThread,
          prompt,
          title,
          model: stringArgument(data.arguments, "model") ?? null,
          status: "running",
          result: null,
          resultPublished: false,
        };
        turn.subagents.set(toolCallId, sub);
        yield* emit({ type: "app_thread.created", driver: COPILOT_PROVIDER, appThread });
        if (prompt) yield* publishChildMessage(sub, "user", prompt, time);
        yield* publishSubagent(turn, sub);
      });

      const resolvePending = Effect.fnUntraced(function* (
        entry: PendingRequest,
        status: "resolved" | "cancelled",
        response?: Pick<OrchestrationV2RuntimeRequest, "decision" | "answers">,
      ) {
        const time = yield* DateTime.now;
        pending.delete(entry.request.id);
        entry.request = {
          ...entry.request,
          ...response,
          status,
          resolvedAt: time,
          responseCapability: {
            type: "not_resumable",
            reason: "This GitHub Copilot request has ended.",
          },
        };
        const settled = status === "resolved" ? "completed" : "cancelled";
        entry.node = { ...entry.node, status: settled, completedAt: time };
        entry.item = { ...entry.item, status: settled, completedAt: time, updatedAt: time };
        yield* emit({
          type: "runtime_request.updated",
          driver: COPILOT_PROVIDER,
          threadId: entry.node.threadId,
          runtimeRequest: entry.request,
        });
        yield* emit({ type: "node.updated", driver: COPILOT_PROVIDER, node: entry.node });
        yield* emit({ type: "turn_item.updated", driver: COPILOT_PROVIDER, turnItem: entry.item });
      });
      const publishRequest = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        request:
          | {
              readonly type: "approval";
              readonly native: PermissionRequest;
              readonly promptRequest: PromptRequest;
            }
          | { readonly type: "question"; readonly native: UserInputRequest },
        respond: PendingRequest["respond"],
        cancel: () => void,
      ) {
        const nativeId = `${turn.nativeId}:request:${++nextLocalId}`;
        const requestId = yield* idAllocator.allocate
          .runtimeRequest({
            driver: COPILOT_PROVIDER,
            providerTurnId: turn.providerTurn.id,
            nativeRequestId: nativeId,
          })
          .pipe(
            Effect.mapError((cause) => protocolError("Cannot allocate Copilot request", cause)),
          );
        const time = yield* DateTime.now;
        const nodeId = idAllocator.derive.approvalNode({ requestId });
        const kind =
          request.type === "approval" ? permissionRequestKind(request.native) : "user_input";
        const runtimeRequest: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId,
          providerTurnId: turn.providerTurn.id,
          nativeRequestRef: weakRef(nativeId),
          kind,
          status: "pending",
          responseCapability: { type: "live", providerSessionId: input.providerSessionId },
          createdAt: time,
          resolvedAt: null,
        };
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          parentNodeId: turn.input.rootNodeId,
          rootNodeId: turn.input.rootNodeId,
          kind: request.type === "approval" ? "approval_request" : "user_input_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId: turn.root.providerThreadId,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: weakRef(nativeId),
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: time,
          completedAt: null,
        };
        const base = {
          ...baseItem(turn.root, `request:${nativeId}`, time),
          id: idAllocator.derive.approvalTurnItem({ requestId }),
          nodeId,
          nativeItemRef: weakRef(nativeId),
          status: "waiting" as const,
          title: null,
          completedAt: null,
        };
        const item: OrchestrationV2TurnItem =
          request.type === "approval"
            ? {
                ...base,
                type: "approval_request",
                requestId,
                requestKind: kind === "user_input" ? "permission" : kind,
                prompt: permissionPrompt(request.native),
                options: permissionOptions(request.native, request.promptRequest),
              }
            : {
                ...base,
                type: "user_input_request",
                requestId,
                questions: [
                  {
                    id: USER_INPUT_QUESTION_ID,
                    header: "Question",
                    question: request.native.question.trim() || "GitHub Copilot needs input",
                    options: (request.native.choices ?? [])
                      .map((choice) => choice.trim())
                      .filter(Boolean)
                      .map((choice) => ({ label: choice, description: choice })),
                    multiSelect: false,
                    allowCustomAnswer: request.native.allowFreeform !== false,
                    required: true,
                  },
                ],
              };
        const entry: PendingRequest = { respond, cancel, request: runtimeRequest, node, item };
        pending.set(requestId, entry);
        yield* emit({
          type: "runtime_request.updated",
          driver: COPILOT_PROVIDER,
          threadId: node.threadId,
          runtimeRequest,
        });
        yield* emit({ type: "node.updated", driver: COPILOT_PROVIDER, node });
        yield* emit({ type: "turn_item.updated", driver: COPILOT_PROVIDER, turnItem: item });
        yield* updateSession("waiting");
      });

      const publishProposedPlan = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        request: ExitPlanModeRequest,
      ) {
        const markdown = trimOrUndefined(request.planContent) ?? trimOrUndefined(request.summary);
        if (!markdown) return;
        const time = yield* DateTime.now;
        const base = baseItem(turn.root, `plan:${++nextLocalId}`, time);
        const planId = yield* idAllocator.allocate
          .plan({
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            driver: COPILOT_PROVIDER,
          })
          .pipe(Effect.mapError((cause) => protocolError("Cannot allocate Copilot plan", cause)));
        yield* publishNode(turn.root, base, "plan", "completed", time);
        yield* emit({
          type: "plan.updated",
          driver: COPILOT_PROVIDER,
          plan: {
            id: planId,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            nodeId: base.nodeId,
            kind: "proposed_plan",
            status: "active",
            markdown,
          },
        });
        yield* emit({
          type: "turn_item.updated",
          driver: COPILOT_PROVIDER,
          turnItem: {
            ...base,
            type: "proposed_plan",
            status: "completed",
            title: null,
            completedAt: time,
            planId,
            markdown,
            streaming: false,
          },
        });
      });
      const publishTodos = Effect.fnUntraced(function* (turn: ActiveTurn) {
        const current = session;
        if (!current) return;
        const result = yield* tryCopilot("Failed to read Copilot todos.", () =>
          current.rpc.plan.readSqlTodos(),
        );
        const steps: OrchestrationV2PlanStep[] = result.rows.flatMap((row, index) => {
          const text = trimOrUndefined(row.title) ?? trimOrUndefined(row.description);
          return text
            ? [{ id: `${row.id ?? index}`, text, status: todoStepStatus(row.status) }]
            : [];
        });
        if (!steps.length && !turn.todoPlanId) return;
        const time = yield* DateTime.now;
        const base = baseItem(turn.root, "todo", time);
        const planId =
          turn.todoPlanId ??
          (yield* idAllocator.allocate
            .plan({
              threadId: turn.input.threadId,
              runId: turn.input.runId,
              driver: COPILOT_PROVIDER,
            })
            .pipe(
              Effect.mapError((cause) => protocolError("Cannot allocate Copilot todos", cause)),
            ));
        turn.todoPlanId = planId;
        yield* emit({
          type: "plan.updated",
          driver: COPILOT_PROVIDER,
          plan: {
            id: planId,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            nodeId: base.nodeId,
            kind: "todo_list",
            status: steps.every((step) => step.status === "completed") ? "completed" : "active",
            steps,
          },
        });
        yield* publishNode(turn.root, base, "todo_list", "completed", time);
        yield* emit({
          type: "turn_item.updated",
          driver: COPILOT_PROVIDER,
          turnItem: {
            ...base,
            type: "todo_list",
            status: "completed",
            title: null,
            completedAt: time,
            planId,
            steps,
          },
        });
      });

      const finish = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        status: TerminalStatus,
        detail?: string,
        disposition: "reusable" | "broken" = "reusable",
        usageLimited = false,
      ) {
        if (active !== turn) return;
        active = undefined;
        const completedAt = yield* DateTime.now;
        const childStatus = status === "completed" ? "completed" : status;
        for (const entry of turn.entries.values())
          if (entry.kind === "tool" ? !isSettled(entry.status) : entry.streaming)
            yield* publishEntry(turn, entry, childStatus);
          else if (turn.dirty.has(entry.nativeId)) yield* publishEntry(turn, entry);
        turn.dirty.clear();
        for (const sub of turn.subagents.values())
          if (!isSettled(sub.status)) {
            sub.status = childStatus;
            yield* publishSubagent(turn, sub);
          }
        for (const entry of pending.values()) {
          entry.cancel();
          yield* resolvePending(entry, "cancelled");
        }
        turn.providerTurn = { ...turn.providerTurn, status, completedAt };
        lastProviderTurn = turn.providerTurn;
        yield* emitProviderTurn(turn.providerTurn);
        yield* updateThread({
          status: disposition === "broken" ? "error" : "idle",
          ...(status === "completed" && turn.providerTurn.nativeTurnRef
            ? { nativeConversationHeadRef: turn.providerTurn.nativeTurnRef }
            : {}),
        });
        yield* updateSession(disposition === "broken" ? "error" : "ready", detail ?? null);
        if (status === "failed") {
          const failure = makeProviderFailure({
            class:
              disposition === "broken"
                ? "transport_error"
                : usageLimited
                  ? "usage_limit"
                  : "provider_error",
            message: detail ?? "GitHub Copilot turn failed.",
          });
          const base = baseItem(turn.root, `failure:${turn.nativeId}`, completedAt);
          yield* emit({
            type: "turn_item.updated",
            driver: COPILOT_PROVIDER,
            turnItem: {
              ...base,
              type: "error",
              status: "failed",
              title: usageLimited ? "Usage limit reached" : null,
              completedAt,
              failure,
            },
          });
          yield* emit({
            type: "turn.terminal",
            driver: COPILOT_PROVIDER,
            providerThreadId: turn.providerTurn.providerThreadId,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.input.runOrdinal,
            status,
            failure,
            failureItemOrdinal: base.ordinal,
            threadDisposition: disposition,
          });
        } else {
          yield* emit({
            type: "turn.terminal",
            driver: COPILOT_PROVIDER,
            providerThreadId: turn.providerTurn.providerThreadId,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.input.runOrdinal,
            status,
            failure: null,
            threadDisposition: disposition,
          });
        }
        yield* Deferred.succeed(turn.done, undefined);
      });

      const updateContextUsage = Effect.fnUntraced(function* (
        usedTokens: number,
        maxTokens: number,
      ) {
        const tokenUsage = {
          usedTokens,
          maxTokens,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* updateThread({ contextUsage: tokenUsage });
        const turn = active;
        if (!turn) return;
        turn.providerTurn = {
          ...turn.providerTurn,
          tokenUsage: { ...turn.providerTurn.tokenUsage, ...tokenUsage },
        };
        yield* emitProviderTurn(turn.providerTurn);
      });
      const addTokenUsage = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        usage: SessionEventPayload<"assistant.usage">["data"],
      ) {
        const previous = turn.providerTurn.turnTokenUsage;
        const sum = (a: number | undefined, b: number | undefined) =>
          a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
        const turnTokenUsage = {
          usageScope: "main_agent" as const,
          usageStatus: "partial" as const,
          hasSubagents: turn.subagents.size > 0,
          inputTokens: sum(previous?.inputTokens, usage.inputTokens),
          outputTokens: sum(previous?.outputTokens, usage.outputTokens),
          cachedInputTokens: sum(previous?.cachedInputTokens, usage.cacheReadTokens),
          cacheCreationTokens: sum(previous?.cacheCreationTokens, usage.cacheWriteTokens),
          reasoningTokens: sum(previous?.reasoningTokens, usage.reasoningTokens),
        };
        turn.providerTurn = {
          ...turn.providerTurn,
          turnTokenUsage: Object.fromEntries(
            Object.entries(turnTokenUsage).filter(([, value]) => value !== undefined),
          ) as typeof turnTokenUsage,
        };
        yield* emitProviderTurn(turn.providerTurn);
      });

      const toolEntry = (turn: ActiveTurn, toolCallId: string) => {
        const entry = turn.entries.get(`tool:${toolCallId}`);
        return entry?.kind === "tool" ? entry : undefined;
      };
      const appendText = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        kind: "message" | "reasoning",
        nativeId: string,
        delta: string,
        final?: string,
      ) {
        const key = `${kind}:${nativeId}`;
        const existing = turn.entries.get(key);
        if (!existing && final !== undefined && !final.trim()) return;
        const entry =
          existing?.kind === kind ? existing : { kind, nativeId: key, text: "", streaming: true };
        entry.text = final ?? entry.text + delta;
        if (final !== undefined) entry.streaming = false;
        turn.entries.set(key, entry);
        yield* markDirty(turn, key);
      });

      const handleEvent = Effect.fnUntraced(function* (event: SessionEvent) {
        if (event.type === "session.usage_info" && !event.agentId) {
          if (event.data.tokenLimit > 0)
            yield* updateContextUsage(event.data.currentTokens, event.data.tokenLimit);
          return;
        }
        if (event.type === "session.model_change" && !event.agentId) {
          appliedModel = event.data.newModel;
          providerSession = { ...providerSession, model: event.data.newModel };
          return;
        }
        const turn = active;
        if (!turn || (turn.compact && event.type.startsWith("session.compaction"))) return;
        const owner = eventOwner(event);
        const ownerSubagent = owner ? turn.subagents.get(owner) : undefined;
        switch (event.type) {
          case "user.message":
            if (owner || turn.consumed) return;
            turn.consumed = true;
            turn.providerTurn = { ...turn.providerTurn, nativeTurnRef: nativeRef(event.id) };
            return yield* emitProviderTurn(turn.providerTurn);
          case "assistant.message_delta":
            if (!owner)
              yield* appendText(turn, "message", event.data.messageId, event.data.deltaContent);
            return;
          case "assistant.message":
            if (!owner)
              yield* appendText(turn, "message", event.data.messageId, "", event.data.content);
            return;
          case "assistant.reasoning_delta":
            if (!owner)
              yield* appendText(turn, "reasoning", event.data.reasoningId, event.data.deltaContent);
            return;
          case "assistant.reasoning":
            if (!owner)
              yield* appendText(turn, "reasoning", event.data.reasoningId, "", event.data.content);
            return;
          case "assistant.usage":
            if (!owner) yield* addTokenUsage(turn, event.data);
            return;
          case "tool.execution_start": {
            const data = event.data;
            if (owner && !ownerSubagent) return;
            if (!owner && data.toolName === "task") return yield* startSubagent(turn, data);
            const key = `tool:${data.toolCallId}`;
            turn.entries.set(key, {
              kind: "tool",
              nativeId: key,
              target: ownerSubagent?.target ?? turn.root,
              hidden: COPILOT_TOOLS_WITH_NATIVE_ROWS.has(data.toolName),
              status: "running",
              tool: {
                toolName: data.toolName,
                toolTitle: trimOrUndefined(data.toolTitle),
                arguments: data.arguments,
                mcpServerName: data.mcpServerName,
                mcpToolName: data.mcpToolName,
                displayCommand: data.shellToolInfo?.displayCommand,
              },
            });
            return yield* markDirty(turn, key);
          }
          case "tool.shell_output":
          case "tool.execution_partial_result": {
            const entry = toolEntry(turn, event.data.toolCallId);
            if (!entry) return;
            const text =
              event.type === "tool.shell_output" ? event.data.text : event.data.partialOutput;
            entry.tool = { ...entry.tool, output: (entry.tool.output ?? "") + text };
            return yield* markDirty(turn, entry.nativeId);
          }
          case "tool.execution_complete": {
            const data = event.data;
            const sub = owner ? undefined : turn.subagents.get(data.toolCallId);
            if (sub) {
              sub.status = data.success ? "completed" : "failed";
              sub.result =
                trimOrUndefined(data.result?.content) ??
                trimOrUndefined(data.error?.message) ??
                null;
              return yield* publishSubagent(turn, sub);
            }
            const entry = toolEntry(turn, data.toolCallId);
            if (!entry) return;
            entry.status = data.success ? "completed" : "failed";
            entry.tool = {
              ...entry.tool,
              output: data.result?.content ?? entry.tool.output,
              detailedOutput: data.result?.detailedContent,
              error: data.error?.message,
              exitCode: data.shellExecution?.exitCode,
              fileEdits: data.fileEdits,
            };
            turn.dirty.delete(entry.nativeId);
            return yield* publishEntry(turn, entry);
          }
          case "subagent.started":
          case "subagent.completed":
          case "subagent.failed": {
            const sub = turn.subagents.get(event.data.toolCallId);
            if (!sub) return;
            sub.model = event.data.model ?? sub.model;
            if (event.type === "subagent.failed") {
              sub.status = "failed";
              sub.result = sub.result ?? trimOrUndefined(event.data.error) ?? null;
            } else if (event.type === "subagent.completed" && event.data.cancelled) {
              sub.status = "cancelled";
            }
            return yield* publishSubagent(turn, sub);
          }
          case "session.todos_changed":
            if (!owner)
              yield* publishTodos(turn).pipe(
                Effect.catch((cause) => Effect.logWarning("Copilot todos are unreadable", cause)),
              );
            return;
          case "session.compaction_start":
            if (!owner)
              yield* publishSimpleItem(
                turn,
                `compaction:${event.id}`,
                { type: "compaction" },
                "running",
                null,
              );
            return;
          case "session.compaction_complete": {
            if (owner) return;
            const data = event.data;
            const summary = trimOrUndefined(data.summaryContent);
            return yield* publishSimpleItem(
              turn,
              `compaction:${event.parentId ?? event.id}`,
              {
                type: "compaction",
                ...(summary ? { summary } : {}),
                ...(data.preCompactionTokens === undefined
                  ? {}
                  : { beforeTokenCount: data.preCompactionTokens }),
                ...(data.postCompactionTokens === undefined
                  ? {}
                  : { afterTokenCount: data.postCompactionTokens }),
              },
              data.success ? "completed" : "failed",
              data.success ? null : (trimOrUndefined(data.error) ?? null),
            );
          }
          case "session.warning":
            if (!owner)
              yield* publishSimpleItem(
                turn,
                `warning:${event.id}`,
                { type: "system_notice", message: event.data.message },
                "completed",
                "GitHub Copilot",
              );
            return;
          case "session.error":
            if (owner || event.data.eligibleForAutoSwitch) return;
            if (!turn.consumed && !event.data.originatingMessageId) return;
            return yield* finish(
              turn,
              "failed",
              event.data.message,
              "reusable",
              USAGE_LIMIT_ERRORS.has(event.data.errorType),
            );
          case "session.idle":
            if (owner || event.data.mode === "autopilot") return;
            if (event.data.aborted && (turn.consumed || turn.interruptRequested))
              return yield* finish(turn, turn.interruptRequested ? "interrupted" : "cancelled");
            if (turn.consumed) return yield* finish(turn, "completed");
            return;
        }
      });

      const handleInbox = Effect.fnUntraced(function* (entry: Inbox) {
        switch (entry.type) {
          case "event":
            return yield* handleEvent(entry.event);
          case "flush":
            if (active === entry.turn) yield* flush(entry.turn);
            return;
          case "plan":
            if (active) yield* publishProposedPlan(active, entry.request);
            return;
          case "settled": {
            const turn = entry.turn;
            if (active !== turn) return;
            if (entry.error === undefined)
              return yield* finish(turn, turn.interruptRequested ? "interrupted" : "completed");
            if (turn.interruptRequested) return yield* finish(turn, "interrupted");
            const detail = errorMessage(entry.error, "GitHub Copilot turn failed.");
            const disconnected = /disconnected|exited|connection/i.test(detail);
            if (disconnected) broken = true;
            return yield* finish(turn, "failed", detail, disconnected ? "broken" : "reusable");
          }
          case "permission": {
            const turn = active;
            if (!turn || turn.compact) return entry.resolve(USER_NOT_AVAILABLE);
            return yield* publishRequest(
              turn,
              { type: "approval", native: entry.request, promptRequest: entry.promptRequest },
              (response, feedback) =>
                entry.resolve(
                  permissionResult(entry.request, entry.promptRequest, response.decision, feedback),
                ),
              () => entry.resolve(USER_NOT_AVAILABLE),
            );
          }
          case "question": {
            const turn = active;
            if (!turn || turn.compact) return entry.resolve(EMPTY_USER_INPUT);
            return yield* publishRequest(
              turn,
              { type: "question", native: entry.request },
              (response) => entry.resolve(userInputResponse(entry.request, response.answers)),
              () => entry.resolve(EMPTY_USER_INPUT),
            );
          }
        }
      });
      yield* Stream.fromQueue(inbox).pipe(
        Stream.runForEach((entry) =>
          handleInbox(entry).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("GitHub Copilot event handling failed", cause),
            ),
            eventPermit.withPermits(1),
          ),
        ),
        Effect.forkIn(scope),
      );
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (active) yield* finish(active, "cancelled", "GitHub Copilot session closed", "broken");
          closed = true;
          for (const entry of pending.values()) entry.cancel();
          pending.clear();
          const current = session;
          if (current) yield* Effect.tryPromise(() => current.disconnect()).pipe(Effect.ignore);
          yield* Queue.shutdown(inbox);
          yield* Queue.shutdown(events);
        }).pipe(eventPermit.withPermits(1)),
      );

      const sessionConfig = (
        args: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
        mcpSession: McpProviderSession.McpProviderSessionConfig | undefined,
      ) => {
        const instructions = [
          buildRuntimeInstructions({ harness: "GitHub Copilot", model: args.modelSelection.model }),
          t3OrchestrationSystemPrompt(
            mcpSession !== undefined,
            mcpSession?.capabilities?.has("device") === true,
          ),
        ]
          .filter(Boolean)
          .join("\n\n");
        const mcpToken = mcpSession
          ? /^Bearer[ \t]+(\S+)$/i.exec(mcpSession.authorizationHeader)?.[1]
          : undefined;
        return {
          clientName: "t3-code",
          ...copilotSessionModelConfig(args.modelSelection).config,
          workingDirectory: cwd,
          streaming: true,
          enableConfigDiscovery: true,
          systemMessage: { mode: "append", content: instructions },
          mcpOAuthTokenStorage: "in-memory",
          ...(mcpSession
            ? {
                mcpServers: {
                  "t3-code": {
                    type: "http",
                    url: mcpSession.endpoint,
                    headers: { Authorization: mcpSession.authorizationHeader },
                  },
                },
              }
            : {}),
          // The static header normally suffices; answer re-auth only for T3's own endpoint.
          onMcpAuthRequest: (request) =>
            mcpToken && sameEndpoint(request.serverUrl, mcpSession?.endpoint)
              ? { kind: "token", accessToken: mcpToken, tokenType: "Bearer" }
              : null,
          onEvent: (event) => {
            offer({ type: "event", event });
          },
          onPermissionRequest: (request, invocation) => {
            if (permissionAutoApproved(runtimeMode, request, invocation.promptRequest))
              return APPROVE_ONCE;
            return new Promise<PermissionRequestResult>((resolve) => {
              if (
                !offer({
                  type: "permission",
                  request,
                  promptRequest: invocation.promptRequest,
                  resolve,
                })
              )
                resolve(USER_NOT_AVAILABLE);
            });
          },
          onUserInputRequest: (request) =>
            new Promise<UserInputResponse>((resolve) => {
              if (!offer({ type: "question", request, resolve })) resolve(EMPTY_USER_INPUT);
            }),
          // T3 shows the plan and lets the user decide; Copilot must not leave plan mode itself.
          onExitPlanModeRequest: (request) => {
            offer({ type: "plan", request });
            return { approved: false, feedback: PLAN_SHOWN_FEEDBACK };
          },
          onAutoModeSwitchRequest: () => "yes",
        } satisfies SessionConfig;
      };

      const register = Effect.fnUntraced(function* (
        args: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
      ) {
        if (closed || broken)
          return yield* protocolError("GitHub Copilot is unavailable; reopen the session");
        if (active)
          return yield* protocolError("Cannot change Copilot sessions during an active turn");
        const existing = args.existingProviderThread;
        if (
          existing &&
          (existing.driver !== COPILOT_PROVIDER ||
            existing.providerInstanceId !== options.instanceId)
        )
          return yield* protocolError("Copilot thread belongs to another provider instance");
        const requestedId = args.forceNewNativeThread
          ? undefined
          : existing
            ? (existing.nativeThreadRef?.nativeId ?? undefined)
            : input.initialNativeThreadId;
        if (
          thread &&
          session &&
          (!requestedId || requestedId === session.sessionId) &&
          thread.appThreadId === args.threadId
        )
          return thread;
        if (thread)
          return yield* protocolError("Open a new session to attach another Copilot session");
        runtimeMode = args.runtimePolicy.runtimeMode;
        const modelSelection = yield* resolveSelection(args.modelSelection);
        const config = sessionConfig(
          { ...args, modelSelection },
          yield* mcpSessions.read(args.threadId),
        );
        const created = requestedId
          ? yield* tryCopilot("Failed to resume the GitHub Copilot session.", () =>
              client.resumeSession(requestedId, config),
            ).pipe(
              Effect.catchIf(
                (error) => /not found/i.test(errorMessage(error.cause, error.detail)),
                () =>
                  Effect.logWarning(
                    "The Copilot session no longer exists; starting a fresh one",
                  ).pipe(
                    Effect.andThen(
                      tryCopilot("Failed to create a GitHub Copilot session.", () =>
                        client.createSession(config),
                      ),
                    ),
                  ),
              ),
            )
          : yield* tryCopilot("Failed to create a GitHub Copilot session.", () =>
              client.createSession(config),
            );
        session = created;
        appliedModel = undefined;
        yield* applyModel(modelSelection);
        const createdAt = yield* DateTime.now;
        thread = existing
          ? {
              ...existing,
              providerSessionId: input.providerSessionId,
              nativeThreadRef: nativeRef(created.sessionId),
              status: "idle",
              updatedAt: createdAt,
            }
          : {
              id: idAllocator.derive.providerThread({
                driver: COPILOT_PROVIDER,
                providerInstanceId: options.instanceId,
                nativeThreadId: created.sessionId,
              }),
              driver: COPILOT_PROVIDER,
              providerInstanceId: options.instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: args.threadId,
              ownerNodeId: null,
              nativeThreadRef: nativeRef(created.sessionId),
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt,
              updatedAt: createdAt,
            };
        yield* emit({
          type: "provider_thread.updated",
          driver: COPILOT_PROVIDER,
          providerThread: thread,
        });
        return thread;
      });

      /** Switches only when the selection changed; session config cannot express every effort. */
      const applyModel = Effect.fnUntraced(function* (selection: ModelSelection) {
        const current = session;
        if (!current) return;
        const model = copilotSessionModelConfig(selection);
        const key = `${model.config.model}|${model.config.reasoningEffort ?? ""}|${model.config.contextTier ?? ""}|${model.needsSwitch}`;
        if (appliedModel === key) return;
        if (appliedModel !== undefined || model.needsSwitch)
          yield* switchCopilotModel(current, selection);
        appliedModel = key;
        providerSession = { ...providerSession, model: selection.model };
      });

      const prompt = Effect.fnUntraced(function* (
        message: ProviderAdapter.ProviderAdapterV2TurnMessage,
      ) {
        const text = yield* providerMessageTextWithAttachmentPaths({
          text: message.text,
          attachments: message.attachments,
          resolveAttachmentPath: providerHost.resolveAttachmentPath,
          resolveExtractedTextPath: providerHost.resolveExtractedTextPath,
        });
        const attachments: NonNullable<MessageOptions["attachments"]> = [];
        for (const attachment of message.attachments)
          if (isProviderNativeImageAttachment(attachment)) {
            const path = providerHost.resolveAttachmentPath(attachment);
            if (!path) return yield* protocolError("Copilot image attachment is missing");
            const bytes = yield* fileSystem
              .readFile(path)
              .pipe(Effect.mapError((cause) => protocolError("Cannot read Copilot image", cause)));
            attachments.push({
              type: "blob",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
              displayName: attachment.name,
            });
          }
        if (!text && !attachments.length)
          return yield* protocolError("GitHub Copilot needs text or an image");
        return { prompt: text, ...(attachments.length ? { attachments } : {}) };
      });

      const validateThread = (candidate: OrchestrationV2ProviderThread) =>
        thread !== undefined &&
        session !== undefined &&
        candidate.driver === COPILOT_PROVIDER &&
        candidate.providerInstanceId === options.instanceId &&
        candidate.appThreadId === thread.appThreadId &&
        candidate.nativeThreadRef?.nativeId === session.sessionId;

      const start = Effect.fnUntraced(function* (
        turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
        compact = false,
      ) {
        const current = session;
        if (!current || !validateThread(turnInput.providerThread) || broken || closed)
          return yield* protocolError("Copilot thread is not attached to this session");
        if (active)
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver: COPILOT_PROVIDER,
            detail: "GitHub Copilot already has an active turn; queue through the orchestrator",
            reason: "previous_turn_active",
          });
        runtimeMode = turnInput.runtimePolicy.runtimeMode;
        const message = compact ? undefined : yield* prompt(turnInput.message);
        if (!compact) yield* applyModel(yield* resolveSelection(turnInput.modelSelection));
        // Attempt ids are unique across restarts of a resumed Copilot session.
        const nativeId = turnInput.attemptId;
        const startedAt = yield* DateTime.now;
        const providerTurn: OrchestrationV2ProviderTurn = {
          id: idAllocator.derive.providerTurn({
            driver: COPILOT_PROVIDER,
            nativeTurnId: `${options.instanceId}:${current.sessionId}:${nativeId}`,
          }),
          providerThreadId: turnInput.providerThread.id,
          nodeId: turnInput.rootNodeId,
          runAttemptId: turnInput.attemptId,
          // Set to the root user.message id once Copilot records it; rollback and fork cut there.
          nativeTurnRef: null,
          ordinal: turnInput.providerTurnOrdinal,
          status: "running",
          startedAt,
          completedAt: null,
        };
        const turn: ActiveTurn = {
          input: turnInput,
          providerTurn,
          nativeId,
          root: {
            threadId: turnInput.threadId,
            runId: turnInput.runId,
            rootNodeId: turnInput.rootNodeId,
            providerThreadId: turnInput.providerThread.id,
            providerTurnId: providerTurn.id,
            scope: `${options.instanceId}:${turnInput.providerThread.id}:${nativeId}`,
            ordinals: new Map(),
            started: new Map(),
            nextOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
          },
          entries: new Map(),
          dirty: new Set(),
          subagents: new Map(),
          done: yield* Deferred.make<void>(),
          compact,
          consumed: false,
          flushScheduled: false,
          interruptRequested: false,
        };
        yield* Effect.gen(function* () {
          thread = turnInput.providerThread;
          active = turn;
          yield* emitProviderTurn(providerTurn);
          yield* updateThread({
            status: "active",
            firstRunOrdinal: thread.firstRunOrdinal ?? turnInput.runOrdinal,
            lastRunOrdinal: turnInput.runOrdinal,
          });
          yield* updateSession("running");
        }).pipe(eventPermit.withPermits(1));

        if (compact) {
          yield* Effect.gen(function* () {
            const result = yield* tryCopilot("GitHub Copilot could not compact the thread.", () =>
              current.rpc.history.compact(),
            );
            if (!result.success)
              return yield* protocolError("GitHub Copilot could not compact the thread.");
            const summary = trimOrUndefined(result.summaryContent);
            yield* eventPermit.withPermits(1)(
              Effect.gen(function* () {
                if (active !== turn) return;
                yield* publishSimpleItem(
                  turn,
                  "compaction",
                  { type: "compaction", ...(summary ? { summary } : {}) },
                  "completed",
                  null,
                );
                yield* finish(turn, "completed");
              }),
            );
          }).pipe(
            Effect.catchCause((cause) =>
              eventPermit.withPermits(1)(
                finish(
                  turn,
                  turn.interruptRequested ? "interrupted" : "failed",
                  errorMessage(cause, "GitHub Copilot could not compact the thread."),
                ),
              ),
            ),
            Effect.forkIn(scope),
          );
          return;
        }
        const sendOptions: MessageOptions = {
          ...message!,
          agentMode: turnInput.runtimePolicy.interactionMode === "plan" ? "plan" : "interactive",
        };
        // Events drive the turn; the promise also reports disconnects, which emit no event.
        current.sendAndWait(sendOptions, UNBOUNDED_TURN_MS).then(
          () => offer({ type: "settled", turn }),
          (error: unknown) => offer({ type: "settled", turn, error }),
        );
      });

      const snapshot = Effect.fnUntraced(function* (current: OrchestrationV2ProviderThread) {
        const copilot = session;
        if (!copilot) return yield* protocolError("GitHub Copilot session is not attached");
        const history = yield* tryCopilot("Failed to read the GitHub Copilot session.", () =>
          copilot.getEvents(),
        );
        const now = yield* DateTime.now;
        const messages = history.flatMap((event): OrchestrationV2ConversationMessage[] => {
          if (eventOwner(event)) return [];
          const role =
            event.type === "user.message"
              ? "user"
              : event.type === "assistant.message"
                ? "assistant"
                : undefined;
          if (!role) return [];
          const text = (event.data as { readonly content: string }).content;
          if (!text.trim()) return [];
          return [
            {
              id: idAllocator.derive.messageFromProviderItem({
                driver: COPILOT_PROVIDER,
                nativeItemId: `${options.instanceId}:${current.id}:history:${event.id}`,
              }),
              threadId: current.appThreadId ?? input.threadId,
              runId: null,
              nodeId: null,
              role,
              text,
              attachments: [],
              streaming: false,
              createdBy: role === "assistant" ? "agent" : "user",
              creationSource: "provider",
              createdAt: now,
              updatedAt: now,
            },
          ];
        });
        return {
          providerThread: current,
          providerTurns: lastProviderTurn ? [lastProviderTurn] : [],
          messages,
          runtimeRequests: [...pending.values()].map((entry) => entry.request),
        } satisfies ProviderAdapter.ProviderAdapterV2ThreadSnapshot;
      });

      /** Immediate sends join the active run, so the original send still settles the turn. */
      const steer = Effect.fnUntraced(function* (
        args: ProviderAdapter.ProviderAdapterV2SteerInput,
      ) {
        const turn = active;
        const current = session;
        const isActive = () =>
          active === turn &&
          turn !== undefined &&
          !turn.compact &&
          !turn.interruptRequested &&
          turn.providerTurn.id === args.providerTurnId;
        if (!current || !isActive())
          return yield* protocolError(`Copilot turn ${args.providerTurnId} is not active`);
        const message = yield* prompt(args.message);
        if (!isActive())
          return yield* protocolError(`Copilot turn ${args.providerTurnId} is not active`);
        yield* tryCopilot("GitHub Copilot could not steer the turn.", () =>
          current.send({ ...message, mode: "immediate" }),
        );
      });

      /** Truncates native history at the user.message that opened the first discarded turn. */
      const rollback = Effect.fnUntraced(function* (
        args: ProviderAdapter.ProviderAdapterV2RollbackThreadInput,
      ) {
        const current = session;
        if (!current || !validateThread(args.providerThread) || broken || closed)
          return yield* protocolError("Copilot thread is not attached to this session");
        if (active) return yield* protocolError("Cannot roll back while a Copilot turn is active");
        const target = args.target.type === "provider_turn" ? args.target.providerTurn : undefined;
        const eventId = copilotTurnBoundary(
          args.providerThreadTurns,
          args.providerThread.id,
          target?.ordinal ?? 0,
        );
        if (eventId)
          yield* tryCopilot("GitHub Copilot could not roll back the thread.", () =>
            current.rpc.history.truncate({ eventId }),
          );
        lastProviderTurn = target;
        yield* updateThread({ nativeConversationHeadRef: target?.nativeTurnRef ?? null });
        return yield* snapshot(thread ?? args.providerThread);
      });

      /** Copies the source session natively, then attaches the copy to this session. */
      const fork = Effect.fnUntraced(function* (
        args: ProviderAdapter.ProviderAdapterV2ForkThreadInput,
      ) {
        const source = args.sourceProviderThread;
        const sourceId = source.nativeThreadRef?.nativeId;
        if (
          !sourceId ||
          source.driver !== COPILOT_PROVIDER ||
          source.providerInstanceId !== options.instanceId
        )
          return yield* protocolError("Copilot fork source has no session on this instance");
        let toEventId: string | undefined;
        if (args.providerTurnId !== undefined) {
          const turns = args.sourceProviderTurns ?? [];
          const selected = turns.find((turn) => turn.id === args.providerTurnId);
          if (!selected) return yield* protocolError("Copilot fork target turn is missing");
          toEventId = copilotTurnBoundary(turns, source.id, selected.ordinal);
        }
        const forked = yield* tryCopilot("GitHub Copilot could not fork the session.", () =>
          client.rpc.sessions.fork({ sessionId: sourceId, ...(toEventId ? { toEventId } : {}) }),
        );
        const now = yield* DateTime.now;
        return yield* register({
          threadId: args.targetThreadId,
          modelSelection: args.modelSelection ?? input.modelSelection,
          runtimePolicy: args.runtimePolicy ?? input.runtimePolicy,
          existingProviderThread: {
            ...source,
            id: idAllocator.derive.providerThread({
              driver: COPILOT_PROVIDER,
              providerInstanceId: options.instanceId,
              nativeThreadId: forked.sessionId,
            }),
            providerSessionId: input.providerSessionId,
            appThreadId: args.targetThreadId,
            ownerNodeId: args.ownerNodeId ?? null,
            nativeThreadRef: nativeRef(forked.sessionId),
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            pendingBackgroundTasks: [],
            forkedFrom: {
              providerThreadId: source.id,
              ...(args.providerTurnId === undefined ? {} : { providerTurnId: args.providerTurnId }),
            },
            createdAt: now,
            updatedAt: now,
          },
        });
      });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: COPILOT_PROVIDER,
        providerSessionId: input.providerSessionId,
        providerSession,
        events: Stream.fromQueue(events),
        backgroundTasksEndWithProcess: true,
        ensureThread: (args) =>
          register(args).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver: COPILOT_PROVIDER,
                  threadId: args.threadId,
                  cause,
                }),
            ),
          ),
        resumeThread: (args) =>
          register({
            threadId: args.threadId ?? args.providerThread.appThreadId ?? input.threadId,
            modelSelection: args.modelSelection ?? input.modelSelection,
            runtimePolicy: args.runtimePolicy ?? input.runtimePolicy,
            existingProviderThread: args.providerThread,
          }).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver: COPILOT_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: args.providerThread.id,
                  cause,
                }),
            ),
          ),
        startTurn: (args) =>
          start(args).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: COPILOT_PROVIDER,
                  threadId: args.threadId,
                  providerThreadId: args.providerThread.id,
                  runId: args.runId,
                  cause,
                }),
            ),
          ),
        compactThread: (args) =>
          start(args, true).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: COPILOT_PROVIDER,
                  threadId: args.threadId,
                  providerThreadId: args.providerThread.id,
                  runId: args.runId,
                  cause,
                }),
            ),
          ),
        steerTurn: (args) =>
          steer(args).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterSteerRunError({
                  driver: COPILOT_PROVIDER,
                  providerThreadId: args.providerThread.id,
                  providerTurnId: args.providerTurnId,
                  cause,
                }),
            ),
          ),
        interruptTurn: Effect.fn("CopilotAdapter.interruptTurn")(
          function* (args) {
            const turn = active;
            const current = session;
            if (
              !turn ||
              !current ||
              turn.providerTurn.id !== args.providerTurnId ||
              !validateThread(args.providerThread)
            )
              return yield* protocolError("This GitHub Copilot turn is no longer active");
            turn.interruptRequested = true;
            yield* tryCopilot("Failed to interrupt GitHub Copilot.", () => current.abort());
            yield* Deferred.await(turn.done).pipe(
              Effect.timeout("30 seconds"),
              Effect.catch(() => eventPermit.withPermits(1)(finish(turn, "interrupted"))),
            );
          },
          (effect, args) =>
            effect.pipe(
              commands.withPermits(1),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterInterruptError({
                    driver: COPILOT_PROVIDER,
                    providerThreadId: args.providerThread.id,
                    providerTurnId: args.providerTurnId,
                    cause,
                  }),
              ),
            ),
        ),
        respondToRuntimeRequest: Effect.fn("CopilotAdapter.respondToRuntimeRequest")(
          function* (args) {
            yield* eventPermit.withPermits(1)(
              Effect.gen(function* () {
                const entry = pending.get(args.requestId);
                if (!entry)
                  return yield* protocolError("This GitHub Copilot request is no longer pending");
                const response = {
                  ...(args.decision ? { decision: args.decision } : {}),
                  ...(args.answers ? { answers: args.answers } : {}),
                };
                entry.respond(response, args.feedback);
                yield* resolvePending(entry, "resolved", response);
                if (active && pending.size === 0) yield* updateSession("running");
              }),
            );
          },
          (effect, args) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                    driver: COPILOT_PROVIDER,
                    requestId: args.requestId,
                    cause,
                  }),
              ),
            ),
        ),
        readThreadSnapshot: (args) =>
          (!validateThread(args.providerThread)
            ? protocolError("Snapshot requested for a different Copilot thread")
            : snapshot(args.providerThread)
          ).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                  driver: COPILOT_PROVIDER,
                  providerThreadId: args.providerThread.id,
                  cause,
                }),
            ),
          ),
        rollbackThread: (args) =>
          rollback(args).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterRollbackThreadError({
                  driver: COPILOT_PROVIDER,
                  providerThreadId: args.providerThread.id,
                  checkpointId: args.target.checkpointId,
                  cause,
                }),
            ),
          ),
        forkThread: (args) =>
          fork(args).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterForkThreadError({
                  driver: COPILOT_PROVIDER,
                  providerThreadId: args.sourceProviderThread.id,
                  cause,
                }),
            ),
          ),
      };
      return runtime;
    }),
  });
});

/** The user.message id opening the first recorded turn after `ordinal`, if any. */
export function copilotTurnBoundary(
  turns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  providerThreadId: ProviderThreadId,
  ordinal: number,
): string | undefined {
  let next: OrchestrationV2ProviderTurn | undefined;
  for (const turn of turns)
    if (
      turn.providerThreadId === providerThreadId &&
      turn.ordinal > ordinal &&
      turn.nativeTurnRef?.strength === "strong" &&
      turn.nativeTurnRef.nativeId &&
      (!next || turn.ordinal < next.ordinal)
    )
      next = turn;
  return next?.nativeTurnRef?.nativeId ?? undefined;
}

function normalizeEndpoint(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.hash
    )
      return undefined;
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    // Query strings may carry short-lived credentials; they are not endpoint identity.
    url.search = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function sameEndpoint(left: string, right: string | undefined): boolean {
  const normalized = normalizeEndpoint(left);
  return normalized !== undefined && normalized === normalizeEndpoint(right);
}
