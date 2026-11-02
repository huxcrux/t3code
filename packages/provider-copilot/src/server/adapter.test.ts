import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  CopilotClient,
  CopilotSession,
  PermissionRequest,
  SessionConfig,
  SessionEvent,
} from "@github/copilot-sdk";
import {
  CheckpointId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ProviderThread,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { CopilotSettings } from "../settings.ts";
import { copilotTurnBoundary, makeCopilotAdapterV2 } from "./adapter.ts";
import { APPROVE_ONCE } from "./approvals.ts";

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);
const INSTANCE_ID = ProviderInstanceId.make("copilot");
const THREAD_ID = ThreadId.make("thread-copilot-test");
const MODEL = "auto";
const modelSelection = { instanceId: INSTANCE_ID, model: MODEL };

const decodeSettings = Schema.decodeSync(CopilotSettings);

function deferredPromise<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let eventSequence = 0;
const sdkEvent = (
  type: string,
  data: Record<string, unknown>,
  extra: { readonly agentId?: string } = {},
) =>
  ({
    id: `event-${++eventSequence}`,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    type,
    data,
    ...extra,
  }) as unknown as SessionEvent;

const makeFakeCopilot = (aborts: Queue.Queue<void>) => {
  let config: SessionConfig | undefined;
  const sends: Array<ReturnType<typeof deferredPromise<undefined>>> = [];
  const steers: Array<{ readonly prompt: string; readonly mode?: string }> = [];
  const truncations: string[] = [];
  const forks: Array<{ readonly sessionId: string; readonly toEventId?: string }> = [];
  const permissionModes: string[] = [];
  const session = {
    sessionId: "native-session",
    send: async (options: { readonly prompt: string; readonly mode?: string }) => {
      steers.push(options);
      return "steer-message";
    },
    sendAndWait: () => {
      const pending = deferredPromise<undefined>();
      sends.push(pending);
      return pending.promise;
    },
    abort: async () => {
      Queue.offerUnsafe(aborts, undefined);
    },
    disconnect: async () => {},
    getEvents: async () => [],
    rpc: {
      model: { switchTo: async () => ({}) },
      permissions: {
        setMode: async ({ mode }: { readonly mode: string }) => {
          permissionModes.push(mode);
          return { success: true, mode };
        },
      },
      plan: { readSqlTodos: async () => ({ todos: [] }) },
      history: {
        compact: async () => ({}),
        truncate: async ({ eventId }: { readonly eventId: string }) => {
          truncations.push(eventId);
          return { eventsRemoved: 2 };
        },
      },
    },
  } as { sessionId: string } as unknown as CopilotSession;
  const client = {
    start: async () => {},
    stop: async () => [],
    forceStop: async () => {},
    createSession: async (next: SessionConfig) => {
      config = next;
      return session;
    },
    resumeSession: async (id: string, next: SessionConfig) => {
      config = next;
      (session as { sessionId: string }).sessionId = id;
      return session;
    },
    rpc: {
      sessions: {
        fork: async (request: { readonly sessionId: string; readonly toEventId?: string }) => {
          forks.push(request);
          return { sessionId: "forked-session" };
        },
      },
    },
  } as unknown as CopilotClient;
  const requireConfig = () => {
    if (!config) throw new Error("Copilot session was not created");
    return config;
  };
  return {
    client,
    steers,
    truncations,
    forks,
    permissionModes,
    aborts,
    config: requireConfig,
    emit: (event: SessionEvent) => Effect.sync(() => requireConfig().onEvent?.(event)),
    settle: () => Effect.sync(() => sends.shift()?.resolve(undefined)),
  };
};

const makeHarness = Effect.fnUntraced(function* (
  runtimeMode: RuntimeMode = "full-access",
  attachThread = true,
) {
  const fake = makeFakeCopilot(yield* Queue.unbounded<void>());
  // The adapter resolves the configured CLI before handing it to the (faked) SDK client.
  const fileSystem = yield* FileSystem.FileSystem;
  const binaryPath = `${yield* fileSystem.makeTempDirectoryScoped()}/copilot`;
  yield* fileSystem.writeFileString(binaryPath, "#!/bin/sh\n");
  yield* fileSystem.chmod(binaryPath, 0o755);
  const settings = decodeSettings({ enabled: true, binaryPath });
  const adapter = yield* makeCopilotAdapterV2({
    instanceId: INSTANCE_ID,
    settings,
    environment: { PATH: "/usr/bin:/bin" },
    createClient: () => fake.client,
  });
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: null,
  });
  const runtime = yield* adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: ProviderSessionId.make("session-copilot"),
    modelSelection,
    runtimePolicy,
  });
  const emitted = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const all: ProviderAdapter.ProviderAdapterV2Event[] = [];
  yield* runtime.events.pipe(
    Stream.runForEach((event) => {
      all.push(event);
      return Queue.offer(emitted, event);
    }),
    Effect.forkScoped,
  );
  const providerThread = attachThread
    ? yield* runtime.ensureThread({ threadId: THREAD_ID, modelSelection, runtimePolicy })
    : undefined;
  const takeEvent = Effect.fnUntraced(function* <
    T extends ProviderAdapter.ProviderAdapterV2Event["type"],
  >(type: T) {
    while (true) {
      const event = yield* Queue.take(emitted);
      if (event.type === type)
        return event as Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }>;
    }
  });
  const startTurn = Effect.fnUntraced(function* (admit = true) {
    if (!providerThread) throw new Error("No Copilot thread is attached");
    const input = yield* turnInput(providerThread, runtimePolicy);
    yield* runtime.startTurn(input);
    if (admit) yield* fake.emit(sdkEvent("user.message", { content: "Hello Copilot" }));
    return input;
  });
  const providerTurns = () =>
    all.flatMap((event) => (event.type === "provider_turn.updated" ? [event.providerTurn] : []));
  return { fake, runtime, all, takeEvent, startTurn, providerThread, providerTurns };
});

const turnInput = Effect.fnUntraced(function* (
  providerThread: OrchestrationV2ProviderThread,
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): Effect.fn.Return<ProviderAdapter.ProviderAdapterV2TurnInput> {
  const now = yield* DateTime.now;
  const appThread: OrchestrationV2AppThread = {
    id: THREAD_ID,
    projectId: ProjectId.make("project-copilot-test"),
    title: "Copilot test",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: INSTANCE_ID,
    modelSelection,
    runtimeMode: runtimePolicy.runtimeMode,
    interactionMode: runtimePolicy.interactionMode,
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  return {
    appThread,
    threadId: THREAD_ID,
    runId: RunId.make("run-1"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("attempt-1"),
    rootNodeId: NodeId.make("root-1"),
    providerThread,
    message: {
      messageId: MessageId.make("message-1"),
      text: "Hello Copilot",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection,
    runtimePolicy,
  };
});

describe("CopilotAdapterV2", () => {
  it.effect("keeps ordinary tool calls on the root turn and completes on idle", () =>
    Effect.gen(function* () {
      const { fake, all, takeEvent, startTurn } = yield* makeHarness();
      yield* startTurn();
      yield* fake.emit(
        sdkEvent("tool.execution_start", {
          toolCallId: "tool-1",
          toolName: "grep",
          arguments: { pattern: "copilot" },
        }),
      );
      yield* fake.emit(
        sdkEvent("tool.execution_complete", {
          toolCallId: "tool-1",
          success: true,
          result: { content: "match" },
        }),
      );
      yield* fake.emit(sdkEvent("assistant.message", { messageId: "message-a", content: "Done" }));
      yield* fake.emit(sdkEvent("session.idle", {}));
      yield* fake.settle();

      const terminal = yield* takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "completed");
      assert.isFalse(all.some((event) => event.type === "subagent.updated"));
      assert.isFalse(all.some((event) => event.type === "app_thread.created"));
      const toolNode = all.find(
        (event) => event.type === "node.updated" && event.node.kind === "tool_call",
      );
      assert.isDefined(toolNode);
      if (toolNode?.type === "node.updated") {
        assert.strictEqual(toolNode.node.threadId, THREAD_ID);
        assert.strictEqual(toolNode.node.status, "completed");
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("routes only task tool calls and their children into a subagent thread", () =>
    Effect.gen(function* () {
      const { fake, all, takeEvent, startTurn } = yield* makeHarness();
      yield* startTurn();
      yield* fake.emit(
        sdkEvent("tool.execution_start", {
          toolCallId: "task-1",
          toolName: "task",
          arguments: { description: "Explore", prompt: "Look around" },
        }),
      );
      const created = yield* takeEvent("app_thread.created");
      const childThreadId = created.appThread.id;
      assert.notStrictEqual(childThreadId, THREAD_ID);

      yield* fake.emit(
        sdkEvent(
          "tool.execution_start",
          { toolCallId: "child-tool", toolName: "grep", arguments: {} },
          { agentId: "task-1" },
        ),
      );
      yield* fake.emit(
        sdkEvent(
          "tool.execution_complete",
          { toolCallId: "child-tool", success: true, result: { content: "ok" } },
          { agentId: "task-1" },
        ),
      );
      yield* fake.emit(
        sdkEvent("tool.execution_complete", {
          toolCallId: "task-1",
          success: true,
          result: { content: "Found it" },
        }),
      );
      yield* fake.emit(sdkEvent("session.idle", {}));
      yield* fake.settle();
      yield* takeEvent("turn.terminal");

      const subagents = all.filter((event) => event.type === "subagent.updated");
      assert.strictEqual(subagents.length > 0, true);
      assert.isFalse(all.some((event) => event.type === "app_thread.created" && event !== created));
      const childTool = all.find(
        (event) =>
          event.type === "node.updated" &&
          event.node.kind === "tool_call" &&
          event.node.threadId === childThreadId,
      );
      assert.isDefined(childTool);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("answers auto-approved permissions without showing them to the client", () =>
    Effect.gen(function* () {
      const { fake, all, takeEvent, startTurn } = yield* makeHarness("full-access");
      yield* startTurn();
      const request = {
        kind: "shell",
        fullCommandText: "ls",
        intention: "List files",
      } as unknown as PermissionRequest;
      const result = yield* Effect.promise(async () =>
        fake.config().onPermissionRequest!(request, {
          sessionId: "native-session",
        } as never),
      );
      assert.deepStrictEqual(result, APPROVE_ONCE);
      yield* fake.emit(sdkEvent("session.idle", {}));
      yield* fake.settle();
      yield* takeEvent("turn.terminal");
      assert.isFalse(all.some((event) => event.type === "runtime_request.updated"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("asks Copilot for assisted approval recommendations only in auto mode", () =>
    Effect.gen(function* () {
      const auto = yield* makeHarness("auto");
      yield* auto.startTurn();
      assert.deepStrictEqual(auto.fake.permissionModes, ["assisted"]);
      const manual = yield* makeHarness("approval-required");
      yield* manual.startTurn();
      assert.deepStrictEqual(manual.fake.permissionModes, ["manual"]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("asks the client for permissions in approval-required mode", () =>
    Effect.gen(function* () {
      const { fake, takeEvent, startTurn } = yield* makeHarness("approval-required");
      yield* startTurn();
      const request = {
        kind: "shell",
        fullCommandText: "rm -rf build",
        intention: "Clean build",
      } as unknown as PermissionRequest;
      void fake.config().onPermissionRequest!(request, { sessionId: "native-session" } as never);
      const pending = yield* takeEvent("runtime_request.updated");
      assert.strictEqual(pending.runtimeRequest.status, "pending");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("steers the active turn without ending it early", () =>
    Effect.gen(function* () {
      const { fake, runtime, all, takeEvent, startTurn, providerThread, providerTurns } =
        yield* makeHarness();
      const input = yield* startTurn();
      const openingMessageId = `event-${eventSequence}`;
      const { providerTurn } = yield* takeEvent("provider_turn.updated");
      yield* runtime.steerTurn({
        threadId: THREAD_ID,
        runId: input.runId,
        providerThread: providerThread!,
        providerTurnId: providerTurn.id,
        message: { ...input.message, text: "Also check the tests" },
      });
      assert.deepStrictEqual(fake.steers, [{ prompt: "Also check the tests", mode: "immediate" }]);
      yield* fake.emit(sdkEvent("user.message", { content: "Also check the tests" }));
      assert.isFalse(all.some((event) => event.type === "turn.terminal"));
      yield* fake.emit(sdkEvent("session.idle", {}));
      yield* fake.settle();
      const terminal = yield* takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "completed");
      // The opening user.message, not the steer, marks where the turn starts.
      const final = providerTurns().at(-1)!;
      assert.strictEqual(final.nativeTurnRef?.strength, "strong");
      assert.strictEqual(final.nativeTurnRef?.nativeId, openingMessageId);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("aborts again when Copilot admits a turn after its interrupt", () =>
    Effect.gen(function* () {
      const { fake, runtime, takeEvent, startTurn, providerThread } = yield* makeHarness();
      yield* startTurn(false);
      const { providerTurn } = yield* takeEvent("provider_turn.updated");
      const interrupt = yield* runtime
        .interruptTurn({ providerThread: providerThread!, providerTurnId: providerTurn.id })
        .pipe(Effect.forkScoped);
      yield* Queue.take(fake.aborts);
      yield* fake.emit(sdkEvent("user.message", { content: "Hello Copilot" }));
      yield* Queue.take(fake.aborts);
      yield* fake.emit(sdkEvent("session.idle", { aborted: true }));
      yield* Fiber.join(interrupt);
      const terminal = yield* takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "interrupted");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rolls back native history from the first discarded turn", () =>
    Effect.gen(function* () {
      const { fake, runtime, takeEvent, startTurn, providerThread, providerTurns } =
        yield* makeHarness();
      yield* startTurn();
      yield* fake.emit(sdkEvent("session.idle", {}));
      yield* fake.settle();
      yield* takeEvent("turn.terminal");
      const turn = providerTurns().at(-1)!;
      const boundary = turn.nativeTurnRef?.nativeId;
      assert.isString(boundary);

      const kept = yield* runtime.rollbackThread({
        providerThread: providerThread!,
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint-1"),
          appRunOrdinal: 1,
          providerTurn: turn,
        },
        providerThreadTurns: [turn],
      });
      assert.deepStrictEqual(fake.truncations, []);
      assert.deepStrictEqual(kept.providerThread.nativeConversationHeadRef, turn.nativeTurnRef);

      const reset = yield* runtime.rollbackThread({
        providerThread: providerThread!,
        target: {
          type: "thread_start",
          checkpointId: CheckpointId.make("checkpoint-0"),
          appRunOrdinal: 0,
        },
        providerThreadTurns: [turn],
      });
      assert.deepStrictEqual(fake.truncations, [boundary]);
      assert.isNull(reset.providerThread.nativeConversationHeadRef);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("forks a source session up to the turn after the selected one", () =>
    Effect.gen(function* () {
      const source = yield* makeHarness();
      const { fake, runtime } = yield* makeHarness("full-access", false);
      const sourceThread = source.providerThread!;
      const turn = (ordinal: number, nativeId: string | null): OrchestrationV2ProviderTurn => ({
        id: ProviderTurnId.make(`provider-turn-${ordinal}`),
        providerThreadId: sourceThread.id,
        nodeId: NodeId.make(`node-${ordinal}`),
        runAttemptId: null,
        nativeTurnRef:
          nativeId === null ? null : { driver: sourceThread.driver, nativeId, strength: "strong" },
        ordinal,
        status: "completed",
        startedAt: null,
        completedAt: null,
      });
      const turns = [turn(1, "user-1"), turn(2, null), turn(3, "user-3")];
      const targetThreadId = ThreadId.make("thread-copilot-fork");
      const forked = yield* runtime.forkThread({
        sourceProviderThread: sourceThread,
        sourceProviderTurns: turns,
        providerTurnId: turns[0]!.id,
        targetThreadId,
      });
      assert.deepStrictEqual(fake.forks, [{ sessionId: "native-session", toEventId: "user-3" }]);
      assert.strictEqual(forked.nativeThreadRef?.nativeId, "forked-session");
      assert.strictEqual(forked.appThreadId, targetThreadId);
      assert.notStrictEqual(forked.id, sourceThread.id);
      assert.deepStrictEqual(forked.forkedFrom, {
        providerThreadId: sourceThread.id,
        providerTurnId: turns[0]!.id,
      });
      assert.isUndefined(copilotTurnBoundary(turns, sourceThread.id, 3));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
