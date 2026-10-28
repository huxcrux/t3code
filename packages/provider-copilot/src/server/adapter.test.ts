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
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { CopilotSettings } from "../settings.ts";
import { makeCopilotAdapterV2 } from "./adapter.ts";
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

const makeFakeCopilot = () => {
  let config: SessionConfig | undefined;
  const sends: Array<ReturnType<typeof deferredPromise<undefined>>> = [];
  const session = {
    sessionId: "native-session",
    sendAndWait: () => {
      const pending = deferredPromise<undefined>();
      sends.push(pending);
      return pending.promise;
    },
    abort: async () => {},
    disconnect: async () => {},
    getEvents: async () => [],
    rpc: {
      model: { switchTo: async () => ({}) },
      plan: { readSqlTodos: async () => ({ todos: [] }) },
      history: { compact: async () => ({}) },
    },
  } as unknown as CopilotSession;
  const client = {
    start: async () => {},
    stop: async () => [],
    forceStop: async () => {},
    createSession: async (next: SessionConfig) => {
      config = next;
      return session;
    },
    resumeSession: async (_id: string, next: SessionConfig) => {
      config = next;
      return session;
    },
  } as unknown as CopilotClient;
  const requireConfig = () => {
    if (!config) throw new Error("Copilot session was not created");
    return config;
  };
  return {
    client,
    config: requireConfig,
    emit: (event: SessionEvent) => Effect.sync(() => requireConfig().onEvent?.(event)),
    settle: () => Effect.sync(() => sends.shift()?.resolve(undefined)),
  };
};

const makeHarness = Effect.fnUntraced(function* (runtimeMode: RuntimeMode = "full-access") {
  const fake = makeFakeCopilot();
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
  const providerThread = yield* runtime.ensureThread({
    threadId: THREAD_ID,
    modelSelection,
    runtimePolicy,
  });
  const takeEvent = Effect.fnUntraced(function* <
    T extends ProviderAdapter.ProviderAdapterV2Event["type"],
  >(type: T) {
    while (true) {
      const event = yield* Queue.take(emitted);
      if (event.type === type)
        return event as Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }>;
    }
  });
  const startTurn = Effect.fnUntraced(function* () {
    yield* runtime.startTurn(yield* turnInput(providerThread, runtimePolicy));
    yield* fake.emit(sdkEvent("user.message", { content: "Hello Copilot" }));
  });
  return { fake, runtime, all, takeEvent, startTurn };
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
});
