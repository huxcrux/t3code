import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { beforeEach, it } from "@effect/vitest";
import type {
  AssistantUsageEvent,
  CopilotClient,
  CopilotSession,
  MessageOptions,
  SessionConfig,
  SessionEvent,
} from "@github/copilot-sdk";
import { CopilotSettings, type ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { expect, vi } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import type { CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import { makeCopilotAdapter } from "./CopilotAdapter.ts";
import { CopilotUsageLimitsSink } from "../copilotUsageLimits.ts";

type TaskList = Awaited<ReturnType<CopilotSession["rpc"]["tasks"]["list"]>>;
type TaskAgentInfo = Extract<TaskList["tasks"][number], { type: "agent" }>;
type TurnCompleted = Extract<ProviderRuntimeEvent, { type: "turn.completed" }>;
type SdkEventInput = {
  [Type in SessionEvent["type"]]: Omit<
    Extract<SessionEvent, { type: Type }>,
    "id" | "timestamp" | "parentId"
  > &
    Partial<Pick<SessionEvent, "id" | "timestamp" | "parentId">>;
}[SessionEvent["type"]];

const MODEL = "gpt-5.4";
const REPLAY_TIMESTAMP = "1960-01-01T00:00:00.000Z";
const defaultSettings = Schema.decodeSync(CopilotSettings)({});

const sdkMock = vi.hoisted(() => {
  const makeSession = () => ({
    sessionId: "copilot-usage-accounting-session",
    rpc: {
      mode: { set: vi.fn(async () => undefined) },
      history: { truncate: vi.fn(async () => ({ eventsRemoved: 0 })) },
      plan: { read: vi.fn(async () => ({ exists: false, content: null, path: null })) },
      tasks: { list: vi.fn(async (): Promise<TaskList> => ({ tasks: [] })) },
    },
    disconnect: vi.fn(async () => undefined),
    getEvents: vi.fn(async (): Promise<SessionEvent[]> => []),
    setModel: vi.fn(async () => undefined),
    send: vi.fn(async (_options: MessageOptions): Promise<string | undefined> => undefined),
    abort: vi.fn(async () => undefined),
  });
  const state = {
    configs: [] as SessionConfig[],
    session: makeSession(),
    quotaReads: 0,
  };
  return {
    state,
    reset() {
      state.configs = [];
      state.session = makeSession();
      state.quotaReads = 0;
    },
  };
});

vi.mock("../copilotRuntime.ts", async () => {
  const actual =
    await vi.importActual<typeof import("../copilotRuntime.ts")>("../copilotRuntime.ts");
  return {
    ...actual,
    createCopilotClient: vi.fn(() =>
      Effect.succeed({
        rpc: {
          account: {
            getQuota: async () => ({
              quotaSnapshots: {
                premium_interactions: {
                  remainingPercentage: 100 - ++sdkMock.state.quotaReads * 10,
                },
              },
            }),
          },
        },
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => []),
        forceStop: vi.fn(async () => undefined),
        createSession: vi.fn(async (config: SessionConfig) => {
          sdkMock.state.configs.push(config);
          return sdkMock.state.session as unknown as CopilotSession;
        }),
        resumeSession: vi.fn(async (_sessionId: string, config: SessionConfig) => {
          sdkMock.state.configs.push(config);
          return sdkMock.state.session as unknown as CopilotSession;
        }),
      } as unknown as CopilotClient),
    ),
  };
});

beforeEach(() => sdkMock.reset());

class AccountingAdapter extends Context.Service<AccountingAdapter, CopilotAdapterShape>()(
  "t3/provider/Layers/CopilotUsageAccounting.test/AccountingAdapter",
) {}

const AccountingTestLayer = Layer.effect(
  AccountingAdapter,
  makeCopilotAdapter(defaultSettings),
).pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3code-copilot-usage-accounting-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const openSession = Effect.fn("CopilotUsageAccounting.openSession")(function* (name: string) {
  const adapter = yield* AccountingAdapter;
  const threadId = ThreadId.make(`copilot-usage-${name}`);
  yield* Effect.acquireRelease(adapter.startSession({ threadId, runtimeMode: "full-access" }), () =>
    adapter.stopSession(threadId).pipe(Effect.orDie),
  );
  const onEvent = sdkMock.state.configs.at(-1)?.onEvent;
  NodeAssert.ok(onEvent);
  const timestamp = DateTime.formatIso(yield* DateTime.now);
  let eventNumber = 0;
  const emit = (event: SdkEventInput) =>
    onEvent({
      id: `${threadId}-event-${++eventNumber}`,
      timestamp,
      parentId: null,
      ...event,
    });

  const startTurn = Effect.fn("CopilotUsageAccounting.startTurn")(function* () {
    const { turnId } = yield* adapter.sendTurn({ threadId, input: "Account for this work." });
    const sdkTurnId = `${turnId}-loop-1`;
    const events: ProviderRuntimeEvent[] = [];
    const completed = yield* Deferred.make<TurnCompleted>();
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.threadId !== threadId || event.turnId !== turnId) {
            return;
          }
          events.push(event);
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(completed, event);
          }
        }),
      ),
      Effect.forkChild({ startImmediately: true }),
    );
    emit({ type: "assistant.turn_start", data: { turnId: sdkTurnId } });

    const finish = Effect.fn("CopilotUsageAccounting.finishTurn")(function* () {
      // A root answer followed by session.idle completes without a turn-end timer.
      emit({
        type: "assistant.message",
        data: { messageId: `${turnId}-answer`, content: "Work complete." },
      });
      emit({ type: "session.idle", ephemeral: true, data: {} });
      return yield* Deferred.await(completed);
    });
    return { turnId, sdkTurnId, events, completed, finish };
  });

  return { emit, startTurn, timestamp };
});

it.layer(AccountingTestLayer)("Copilot usage accounting", (it) => {
  it.effect(
    "refreshes account quotas on session start and quota errors through the instance sink",
    () =>
      Effect.gen(function* () {
        const first = yield* Deferred.make<void>();
        const second = yield* Deferred.make<void>();
        const percentages: number[] = [];
        const adapter = yield* makeCopilotAdapter(defaultSettings).pipe(
          Effect.provideService(CopilotUsageLimitsSink, {
            record: (limits) =>
              Effect.gen(function* () {
                percentages.push(limits?.windows[0]?.usedPercent ?? -1);
                yield* Deferred.succeed(percentages.length === 1 ? first : second, undefined);
              }),
          }),
        );
        const threadId = ThreadId.make("copilot-usage-limits-refresh");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* Deferred.await(first);
        const onEvent = sdkMock.state.configs.at(-1)?.onEvent;
        NodeAssert.ok(onEvent);
        onEvent({
          id: "quota-error",
          timestamp: DateTime.formatIso(yield* DateTime.now),
          parentId: null,
          type: "session.error",
          data: { errorType: "quota", message: "Quota changed", eligibleForAutoSwitch: true },
        });
        yield* Deferred.await(second);
        expect(percentages).toEqual([10, 20]);
        expect(sdkMock.state.quotaReads).toBe(2);
        yield* adapter.stopSession(threadId);
      }).pipe(Effect.scoped),
  );

  it.effect("accumulates two root SDK calls once without adding cache or reasoning subsets", () =>
    Effect.gen(function* () {
      const { emit, startTurn, timestamp } = yield* openSession("root-loops");
      const turn = yield* startTurn();
      const firstCall = {
        id: "root-call-1-event",
        timestamp,
        parentId: null,
        type: "assistant.usage",
        ephemeral: true,
        data: {
          model: MODEL,
          inputTokens: 100,
          cacheReadTokens: 20,
          cacheWriteTokens: 10,
          outputTokens: 30,
          reasoningTokens: 10,
          duration: 100,
        },
      } satisfies AssistantUsageEvent;
      emit(firstCall);
      emit(firstCall);
      emit({ type: "assistant.turn_end", data: { turnId: turn.sdkTurnId } });
      emit({ type: "assistant.turn_start", data: { turnId: "root-loop-2" } });
      const secondCall = {
        type: "assistant.usage",
        ephemeral: true,
        data: {
          model: MODEL,
          apiCallId: "root-call-2",
          inputTokens: 200,
          cacheReadTokens: 40,
          cacheWriteTokens: 30,
          outputTokens: 50,
          reasoningTokens: 15,
          duration: 150,
        },
      } satisfies SdkEventInput;
      emit(secondCall);
      emit(secondCall);

      const completed = yield* turn.finish();
      expect(completed.payload).toMatchObject({
        state: "completed",
        tokenUsage: {
          usageStatus: "complete",
          usageScope: "main_agent",
          hasSubagents: false,
          inputTokens: 300,
          cachedInputTokens: 60,
          cacheCreationTokens: 40,
          outputTokens: 80,
          reasoningTokens: 25,
        },
      });
      expect(turn.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);

      const nextTurn = yield* startTurn();
      emit({
        type: "assistant.usage",
        ephemeral: true,
        data: { model: MODEL, apiCallId: "next-turn-call", inputTokens: 4, outputTokens: 1 },
      });
      const nextCompleted = yield* nextTurn.finish();
      expect(nextCompleted.payload.tokenUsage).toMatchObject({
        usageStatus: "complete",
        usageScope: "main_agent",
        hasSubagents: false,
        inputTokens: 4,
        outputTokens: 1,
      });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps all child attribution forms out of root usage and publishes cumulative task usage",
    () =>
      Effect.gen(function* () {
        const { emit, startTurn } = yield* openSession("child-calls");
        const turn = yield* startTurn();
        emit({
          type: "subagent.started",
          agentId: "explorer-agent",
          data: {
            toolCallId: "explore-tool",
            agentName: "explore",
            agentDisplayName: "Explorer",
            agentDescription: "Inspect accounting events",
            model: MODEL,
          },
        });
        emit({
          type: "assistant.turn_start",
          agentId: "explorer-agent",
          data: { turnId: turn.sdkTurnId },
        });
        emit({
          type: "assistant.usage",
          ephemeral: true,
          agentId: "explorer-agent",
          data: {
            model: MODEL,
            apiCallId: "child-call-1",
            inputTokens: 20,
            cacheReadTokens: 5,
            cacheWriteTokens: 3,
            outputTokens: 5,
            reasoningTokens: 2,
            duration: 10,
          },
        });
        emit({
          type: "assistant.turn_end",
          agentId: "explorer-agent",
          data: { turnId: turn.sdkTurnId },
        });
        emit({
          type: "assistant.usage",
          ephemeral: true,
          data: {
            model: MODEL,
            apiCallId: "child-call-2",
            parentToolCallId: "explore-tool",
            inputTokens: 30,
            cacheReadTokens: 6,
            cacheWriteTokens: 2,
            outputTokens: 7,
            reasoningTokens: 3,
            duration: 20,
          },
        });
        emit({
          type: "assistant.usage",
          ephemeral: true,
          data: {
            model: MODEL,
            apiCallId: "unlinked-child-call",
            initiator: "sub-agent",
            inputTokens: 1_000,
            outputTokens: 100,
          },
        });
        emit({
          type: "subagent.completed",
          agentId: "explorer-agent",
          data: {
            toolCallId: "explore-tool",
            agentName: "explore",
            agentDisplayName: "Explorer",
            totalTokens: 62,
            durationMs: 80,
            totalToolCalls: 2,
          },
        });
        emit({
          type: "assistant.usage",
          ephemeral: true,
          data: { model: MODEL, apiCallId: "root-call", inputTokens: 70, outputTokens: 10 },
        });

        const completed = yield* turn.finish();
        expect(completed.payload.tokenUsage).toMatchObject({
          usageStatus: "complete",
          usageScope: "main_agent",
          hasSubagents: true,
          inputTokens: 70,
          outputTokens: 10,
        });
        const starts = turn.events.filter((event) => event.type === "task.started");
        expect(starts.map((event) => event.payload.taskId)).toEqual(["explore-tool"]);
        const progress = turn.events
          .filter((event) => event.type === "task.progress")
          .filter((event) => event.payload.typedUsage !== undefined);
        expect(progress.map((event) => event.payload.typedUsage?.totalTokens)).toEqual([25, 62]);
        expect(progress.at(-1)?.payload).toMatchObject({
          taskId: "explore-tool",
          typedUsage: {
            totalTokens: 62,
            inputTokens: 50,
            cachedInputTokens: 11,
            outputTokens: 12,
            reasoningOutputTokens: 5,
            durationMs: 30,
          },
        });
        const taskCompleted = turn.events.find((event) => event.type === "task.completed");
        expect(taskCompleted?.payload).toMatchObject({
          taskId: "explore-tool",
          status: "completed",
          typedUsage: {
            totalTokens: 62,
            inputTokens: 50,
            cachedInputTokens: 11,
            outputTokens: 12,
            reasoningOutputTokens: 5,
            durationMs: 80,
            toolUses: 2,
          },
        });
      }).pipe(Effect.scoped),
  );

  it.effect("attaches early child usage to one canonical task and ignores its context meter", () =>
    Effect.gen(function* () {
      const { emit, startTurn } = yield* openSession("early-child-usage");
      const turn = yield* startTurn();
      const call = {
        type: "assistant.usage",
        ephemeral: true,
        agentId: "early-agent",
        data: {
          model: MODEL,
          apiCallId: "early-call",
          inputTokens: 10,
          outputTokens: 5,
          reasoningTokens: 8,
        },
      } satisfies SdkEventInput;
      emit(call);
      emit({
        type: "subagent.started",
        agentId: "early-agent",
        data: {
          toolCallId: "early-tool",
          agentName: "explore",
          agentDisplayName: "Explorer",
          agentDescription: "Inspect usage",
        },
      });
      emit(call);
      emit({
        type: "session.usage_info",
        ephemeral: true,
        agentId: "early-agent",
        data: { currentTokens: 900, tokenLimit: 1000, messagesLength: 2 },
      });
      emit({
        type: "subagent.completed",
        agentId: "early-agent",
        data: {
          toolCallId: "early-tool",
          agentName: "explore",
          agentDisplayName: "Explorer",
          totalTokens: 15,
        },
      });
      yield* turn.finish();
      expect(
        turn.events
          .filter((event) => event.type === "task.started")
          .map((event) => event.payload.taskId),
      ).toEqual(["early-tool"]);
      expect(
        turn.events.find((event) => event.type === "task.completed")?.payload.typedUsage,
      ).toMatchObject({
        totalTokens: 15,
        inputTokens: 10,
        outputTokens: 5,
        reasoningOutputTokens: 5,
      });
      expect(turn.events.some((event) => event.type === "thread.token-usage.updated")).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "preserves explicit zero counters and rejects old usage and task replays on the next turn",
    () =>
      Effect.gen(function* () {
        const { emit, startTurn, timestamp } = yield* openSession("zero-and-replay");
        const first = yield* startTurn();
        const zeroUsage = {
          id: "zero-root-event",
          timestamp,
          parentId: null,
          type: "assistant.usage",
          ephemeral: true,
          data: {
            model: MODEL,
            apiCallId: "zero-root-call",
            inputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            duration: 0,
          },
        } satisfies AssistantUsageEvent;
        const childStarted = {
          type: "subagent.started",
          agentId: "zero-agent",
          data: {
            toolCallId: "zero-tool",
            agentName: "explore",
            agentDisplayName: "Zero work",
            agentDescription: "Nothing to inspect",
          },
        } satisfies SdkEventInput;
        const childCompleted = {
          type: "subagent.completed",
          agentId: "zero-agent",
          data: {
            toolCallId: "zero-tool",
            agentName: "explore",
            agentDisplayName: "Zero work",
            totalTokens: 0,
            durationMs: 0,
            totalToolCalls: 0,
          },
        } satisfies SdkEventInput;
        emit(zeroUsage);
        emit(childStarted);
        emit(childCompleted);
        const firstCompleted = yield* first.finish();
        expect(firstCompleted.payload.tokenUsage).toMatchObject({
          usageStatus: "complete",
          usageScope: "main_agent",
          hasSubagents: true,
          inputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        });
        expect(
          first.events.find((event) => event.type === "task.completed")?.payload.typedUsage,
        ).toMatchObject({ totalTokens: 0, durationMs: 0, toolUses: 0 });

        const second = yield* startTurn();
        emit({
          type: "assistant.turn_start",
          timestamp: REPLAY_TIMESTAMP,
          data: { turnId: first.sdkTurnId },
        });
        // Fresh IDs ensure rejection depends on timestamps, not previously seen IDs.
        emit({
          ...zeroUsage,
          id: "replayed-root-event",
          timestamp: REPLAY_TIMESTAMP,
          data: { model: MODEL, apiCallId: "old-unseen-call", inputTokens: 900, outputTokens: 90 },
        });
        emit({ ...childStarted, timestamp: REPLAY_TIMESTAMP });
        emit({ ...childCompleted, timestamp: REPLAY_TIMESTAMP });
        emit({
          type: "assistant.usage",
          ephemeral: true,
          data: { model: MODEL, apiCallId: "new-root-call", inputTokens: 9, outputTokens: 1 },
        });
        const secondCompleted = yield* second.finish();
        expect(secondCompleted.payload.tokenUsage).toMatchObject({
          usageStatus: "complete",
          usageScope: "main_agent",
          hasSubagents: false,
          inputTokens: 9,
          outputTokens: 1,
        });
        expect(
          second.events.filter(
            (event) =>
              event.type === "task.started" ||
              event.type === "task.progress" ||
              event.type === "task.completed",
          ),
        ).toHaveLength(0);
      }).pipe(Effect.scoped),
  );

  it.effect("keeps incomplete root calls partial and accepts completion-only child totals", () =>
    Effect.gen(function* () {
      const { emit, startTurn } = yield* openSession("partial-and-completion-only");
      const turn = yield* startTurn();
      emit({
        type: "assistant.usage",
        ephemeral: true,
        data: { model: MODEL, apiCallId: "input-only-call", inputTokens: 30 },
      });
      emit({ type: "assistant.turn_end", data: { turnId: turn.sdkTurnId } });
      emit({ type: "assistant.turn_start", data: { turnId: "partial-loop-2" } });
      emit({
        type: "assistant.usage",
        ephemeral: true,
        data: { model: MODEL, apiCallId: "output-only-call", outputTokens: 7 },
      });
      emit({
        type: "subagent.started",
        agentId: "completion-only-agent",
        data: {
          toolCallId: "completion-only-tool",
          agentName: "explore",
          agentDisplayName: "Explorer",
          agentDescription: "Inspect with no live usage stream",
        },
      });
      emit({
        type: "subagent.completed",
        agentId: "completion-only-agent",
        data: {
          toolCallId: "completion-only-tool",
          agentName: "explore",
          agentDisplayName: "Explorer",
          totalTokens: 123,
          durationMs: 456,
          totalToolCalls: 4,
        },
      });

      const completed = yield* turn.finish();
      expect(completed.payload).toMatchObject({
        state: "completed",
        tokenUsage: {
          usageStatus: "partial",
          usageScope: "main_agent",
          hasSubagents: true,
          inputTokens: 30,
          outputTokens: 7,
        },
      });
      const taskCompleted = turn.events.find((event) => event.type === "task.completed");
      expect(taskCompleted?.payload).toMatchObject({
        taskId: "completion-only-tool",
        status: "completed",
        typedUsage: { totalTokens: 123, durationMs: 456, toolUses: 4 },
      });
      expect(taskCompleted?.payload.typedUsage?.inputTokens).toBeUndefined();
      expect(taskCompleted?.payload.typedUsage?.outputTokens).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("retains child and partial root accounting when the task and session fail", () =>
    Effect.gen(function* () {
      const { emit, startTurn } = yield* openSession("failure");
      const turn = yield* startTurn();
      emit({
        type: "assistant.usage",
        ephemeral: true,
        data: { model: MODEL, apiCallId: "failed-root-call", inputTokens: 6 },
      });
      emit({
        type: "subagent.started",
        agentId: "failed-agent",
        data: {
          toolCallId: "failed-tool",
          agentName: "explore",
          agentDisplayName: "Explorer",
          agentDescription: "Inspect before failure",
        },
      });
      emit({
        type: "assistant.usage",
        ephemeral: true,
        agentId: "failed-agent",
        data: {
          model: MODEL,
          apiCallId: "failed-child-call",
          inputTokens: 12,
          outputTokens: 3,
        },
      });
      emit({
        type: "subagent.failed",
        agentId: "failed-agent",
        data: {
          toolCallId: "failed-tool",
          agentName: "explore",
          agentDisplayName: "Explorer",
          error: "Inspection failed",
          totalTokens: 15,
          durationMs: 40,
          totalToolCalls: 1,
        },
      });
      emit({
        type: "session.error",
        data: { errorType: "query", message: "Provider disconnected" },
      });

      const completed = yield* Deferred.await(turn.completed);
      expect(completed.payload).toMatchObject({
        state: "failed",
        tokenUsage: {
          usageStatus: "partial",
          usageScope: "main_agent",
          hasSubagents: true,
          inputTokens: 6,
        },
      });
      expect(completed.payload.tokenUsage?.outputTokens).toBeUndefined();
      expect(turn.events.find((event) => event.type === "task.completed")?.payload).toMatchObject({
        taskId: "failed-tool",
        status: "failed",
        typedUsage: {
          totalTokens: 15,
          inputTokens: 12,
          outputTokens: 3,
          durationMs: 40,
          toolUses: 1,
        },
      });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "unifies background and lifecycle tasks by toolCallId without duplicate rows or usage",
    () =>
      Effect.gen(function* () {
        const { emit, startTurn, timestamp } = yield* openSession("background-identity");
        const turn = yield* startTurn();
        const task = {
          type: "agent",
          id: "background-task-id",
          toolCallId: "shared-tool-call",
          description: "Inspect accounting",
          status: "running",
          startedAt: timestamp,
          agentType: "explore",
          prompt: "Inspect accounting",
        } satisfies TaskAgentInfo;
        const completedTask = { ...task, status: "completed" } satisfies TaskAgentInfo;
        sdkMock.state.session.rpc.tasks.list
          .mockResolvedValueOnce({ tasks: [task] })
          .mockResolvedValueOnce({ tasks: [task] })
          .mockResolvedValueOnce({ tasks: [completedTask] })
          .mockResolvedValueOnce({ tasks: [completedTask] });
        const started = {
          type: "subagent.started",
          agentId: "background-agent",
          data: {
            toolCallId: task.toolCallId,
            agentName: task.agentType,
            agentDisplayName: "Explorer",
            agentDescription: task.description,
          },
        } satisfies SdkEventInput;
        const backgroundChanged = {
          type: "session.background_tasks_changed",
          ephemeral: true,
          data: {},
        } satisfies SdkEventInput;
        emit(backgroundChanged);
        emit(started);
        emit(started);
        emit(backgroundChanged);
        const usage = {
          id: "background-usage-event",
          timestamp,
          parentId: null,
          type: "assistant.usage",
          ephemeral: true,
          agentId: "background-agent",
          data: {
            model: MODEL,
            apiCallId: "background-api-call",
            parentToolCallId: task.toolCallId,
            inputTokens: 10,
            outputTokens: 4,
          },
        } satisfies AssistantUsageEvent;
        emit(usage);
        emit(usage);
        emit({ ...usage, id: "background-usage-forwarded" });
        const taskFinished = {
          type: "subagent.completed",
          agentId: "background-agent",
          data: {
            toolCallId: task.toolCallId,
            agentName: task.agentType,
            agentDisplayName: "Explorer",
            totalTokens: 14,
            durationMs: 50,
            totalToolCalls: 1,
          },
        } satisfies SdkEventInput;
        emit(taskFinished);
        emit(taskFinished);
        emit(backgroundChanged);
        emit(backgroundChanged);

        const completed = yield* turn.finish();
        const starts = turn.events.filter((event) => event.type === "task.started");
        const completions = turn.events.filter((event) => event.type === "task.completed");
        expect(starts.map((event) => event.payload.taskId)).toEqual([task.toolCallId]);
        expect(completions).toHaveLength(1);
        expect(completions[0]?.payload).toMatchObject({
          taskId: task.toolCallId,
          status: "completed",
          typedUsage: {
            totalTokens: 14,
            inputTokens: 10,
            outputTokens: 4,
            durationMs: 50,
            toolUses: 1,
          },
        });
        const progress = turn.events.filter((event) => event.type === "task.progress");
        expect(progress.every((event) => event.payload.taskId === task.toolCallId)).toBe(true);
        expect(
          progress
            .filter((event) => event.payload.typedUsage !== undefined)
            .map((event) => event.payload.typedUsage?.totalTokens),
        ).toEqual([14]);
        expect(completed.payload.tokenUsage).toMatchObject({
          usageStatus: "unavailable",
          usageScope: "main_agent",
          hasSubagents: true,
        });
        expect(completed.payload.tokenUsage?.inputTokens).toBeUndefined();
        expect(completed.payload.tokenUsage?.outputTokens).toBeUndefined();
      }).pipe(Effect.scoped),
  );
});
