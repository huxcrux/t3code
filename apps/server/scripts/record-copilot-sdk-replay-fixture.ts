// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ProviderReplayEntry } from "@t3tools/contracts";
import { CopilotSettings } from "@t3tools/provider-copilot/settings";
import {
  COPILOT_PROVIDER,
  makeCopilotAdapterV2,
  makeScriptedCopilotClient,
} from "@t3tools/provider-copilot/testing";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  COPILOT_REPLAY_INSTANCE_ID,
  COPILOT_SDK_JSONRPC_PROTOCOL,
  copilotReplayAgentScript,
} from "../src/orchestration-v2/Adapters/CopilotAdapterV2.testkit.ts";
import * as ProviderAdapterRegistry from "../src/orchestration-v2/ProviderAdapterRegistry.ts";
import { provideDeterministicTestRuntime } from "../src/orchestration-v2/testkit/DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "../src/orchestration-v2/testkit/fixtures/index.ts";
import {
  materializeFixtureInput,
  TOOL_CALL_READ_ONLY_WORKSPACE_ROOT,
} from "../src/orchestration-v2/testkit/fixtures/shared.ts";
import { runOrchestratorV2Scenario } from "../src/orchestration-v2/testkit/OrchestratorScenario.ts";
import * as ProviderReplayHarness from "../src/orchestration-v2/testkit/ProviderReplayHarness.ts";

const wallClock = Clock.Clock.defaultValue();
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const HOME_PLACEHOLDER = "/home/copilot-replay";
const DROPPED_NOTIFICATIONS = new Set(["host.event", "session.lifecycle"]);
// Telemetry and streaming detail neither the SDK nor the adapter reads.
const DROPPED_EVENTS = new Set([
  "assistant.streaming_delta",
  "assistant.tool_call_delta",
  "sandbox.decision",
  "session.background_tasks_changed",
  "session.usage_checkpoint",
  "session.usage_info",
]);

interface JsonRpcMessage {
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface WireMessage {
  readonly pid: number;
  readonly direction: "in" | "out";
  readonly message: JsonRpcMessage;
}

function readArgValues(name: string): ReadonlyArray<string> {
  const args = process.argv.slice(2);
  return args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1]!] : []));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, map));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, mapStrings(entry, map)]),
  );
}

function readWire(logPath: string): ReadonlyArray<WireMessage> {
  if (!NodeFS.existsSync(logPath)) return [];
  return NodeFS.readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => decodeJson(line) as WireMessage);
}

function eventType(message: JsonRpcMessage): string | undefined {
  const params = isRecord(message.params) ? message.params : undefined;
  const event = isRecord(params?.event) ? params.event : undefined;
  return typeof event?.type === "string" ? event.type : undefined;
}

function dropInbound(message: JsonRpcMessage): boolean {
  if (message.method === undefined) return false;
  if (DROPPED_NOTIFICATIONS.has(message.method)) return true;
  const type = eventType(message);
  return (
    type !== undefined &&
    (type.startsWith("model.") || type.startsWith("session.mcp_") || DROPPED_EVENTS.has(type))
  );
}

const decodeCopilotSettings = Schema.decodeEffect(CopilotSettings);
const UNORDERED_SHUTDOWN_METHOD = "runtime.shutdown";

function wireToEntries(wire: ReadonlyArray<WireMessage>): {
  readonly entries: Array<ProviderReplayEntry>;
  readonly droppedFrames: number;
} {
  // Each CLI process replays in its own replay agent, so its frames stay together.
  const byProcess = new Map<number, Array<ProviderReplayEntry>>();
  const requests = new Map<string, string>();
  let droppedFrames = 0;
  for (const { pid, direction, message } of wire) {
    const entries = byProcess.get(pid) ?? [];
    byProcess.set(pid, entries);
    const type = direction === "out" ? "expect_outbound" : "emit_inbound";
    if (typeof message.method === "string") {
      if (direction === "in" && dropInbound(message)) {
        droppedFrames += 1;
        continue;
      }
      const isRequest = message.id !== undefined && message.id !== null;
      if (isRequest && direction === "in") {
        throw new Error(`The Copilot CLI sent a request (${message.method}); replay cannot.`);
      }
      if (isRequest) requests.set(`${pid}:${message.id}`, message.method);
      // The replay agent answers teardown itself; it can overlap the next CLI process.
      if (message.method === UNORDERED_SHUTDOWN_METHOD) {
        droppedFrames += 1;
        continue;
      }
      const kind = isRequest ? "request" : "notification";
      const event = eventType(message);
      entries.push({
        type,
        label: `${kind}:${message.method}${event === undefined ? "" : `:${event}`}`,
        frame: {
          kind,
          method: message.method,
          ...(message.params === undefined ? {} : { params: message.params }),
        },
      });
      continue;
    }
    const method = requests.get(`${pid}:${message.id}`);
    if (method === undefined || direction !== "in") {
      throw new Error(`Unmatched Copilot response ${encodeJson(message)}`);
    }
    requests.delete(`${pid}:${message.id}`);
    if (method === UNORDERED_SHUTDOWN_METHOD) {
      droppedFrames += 1;
      continue;
    }
    entries.push({
      type,
      label: `response:${method}`,
      frame: {
        kind: "response",
        method,
        ...(message.result === undefined ? {} : { result: message.result }),
        ...(message.error === undefined ? {} : { error: message.error }),
      },
    });
  }
  const entries = [...byProcess.values()].flatMap((process, index) =>
    index === 0 ? process : [{ type: "runtime_exit", status: "success" } as const, ...process],
  );
  return { entries, droppedFrames };
}

function normalizeOutbound(frame: Record<string, unknown>): Record<string, unknown> {
  const params = isRecord(frame.params) ? frame.params : undefined;
  if (params === undefined) return frame;
  if (frame.method !== "session.create" && frame.method !== "session.resume") return frame;
  return {
    ...frame,
    params: {
      ...params,
      ...(isRecord(params.systemMessage)
        ? { systemMessage: { ...params.systemMessage, content: "<any>" } }
        : {}),
      ...(params.mcpServers === undefined ? {} : { mcpServers: "<any>" }),
    },
  };
}

function normalizeInbound(frame: Record<string, unknown>): Record<string, unknown> {
  const params = isRecord(frame.params) ? frame.params : undefined;
  const event = isRecord(params?.event) ? params.event : undefined;
  const data = isRecord(event?.data) ? event.data : undefined;
  if (event?.type !== "system.message" || data === undefined) return frame;
  return {
    ...frame,
    params: {
      ...params,
      event: {
        ...event,
        data: {
          ...data,
          content: "<system prompt>",
          ...(Array.isArray(data.contentBlocks)
            ? {
                contentBlocks: data.contentBlocks.map((block) =>
                  isRecord(block) ? { ...block, content: "<system prompt>" } : block,
                ),
              }
            : {}),
        },
      },
    },
  };
}

function normalizeEntries(input: {
  readonly entries: ReadonlyArray<ProviderReplayEntry>;
  readonly workspaces: ReadonlyArray<string>;
  readonly home: string;
  readonly user: string;
}): Array<ProviderReplayEntry> {
  const sessionIds: Array<string> = [];
  for (const entry of input.entries) {
    if (entry.type !== "expect_outbound" || !isRecord(entry.frame)) continue;
    const params = isRecord(entry.frame.params) ? entry.frame.params : undefined;
    if (entry.frame.method === "session.create" && typeof params?.sessionId === "string") {
      sessionIds.push(params.sessionId);
    }
  }
  const replacements: Array<readonly [string, string]> = [
    ...sessionIds.map(
      (id, index) => [id, index === 0 ? "<$session>" : `<$session${index + 1}>`] as const,
    ),
    ...input.workspaces.map((workspace) => [workspace, "<workspace>"] as const),
    [input.home, HOME_PLACEHOLDER],
  ];
  const user = /^[a-z_][a-z0-9_-]*$/iu.test(input.user) ? input.user : "";
  const userPattern = user.length === 0 ? undefined : new RegExp(`\\b${user}\\b`, "gu");
  const replaceAll = (text: string) => {
    const replaced = replacements.reduce(
      (current, [from, to]) => (from.length === 0 ? current : current.replaceAll(from, to)),
      text,
    );
    return userPattern === undefined ? replaced : replaced.replace(userPattern, "copilot-replay");
  };
  return input.entries.map((entry) => {
    if (entry.type === "runtime_exit" || !isRecord(entry.frame)) return entry;
    const frame =
      entry.type === "expect_outbound"
        ? normalizeOutbound(entry.frame)
        : normalizeInbound(entry.frame);
    return { ...entry, frame: mapStrings(frame, replaceAll) };
  });
}

const recordScenario = Effect.fn("recordCopilotScenario")(function* (fixtureName: string) {
  const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((candidate) => candidate.name === fixtureName);
  const variant = fixture?.providers.find((provider) => provider.driver === COPILOT_PROVIDER);
  if (fixture === undefined || variant === undefined) {
    return yield* Effect.die(new Error(`No Copilot replay fixture named '${fixtureName}'.`));
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fixtureInput = fixture.buildInput();
  const workspace = yield* checkpointWorkspace(fixtureName, fixtureInput.workspaceFiles);
  const realWorkspace = yield* fs.realPath(workspace);
  if (fixtureName === "tool_call_read_only") {
    // The shared prompt reads absolute paths outside the checkpoint workspace.
    yield* fs.makeDirectory(TOOL_CALL_READ_ONLY_WORKSPACE_ROOT, { recursive: true });
    yield* fs.writeFileString(
      path.join(TOOL_CALL_READ_ONLY_WORKSPACE_ROOT, "package.json"),
      `${encodeJson({ name: "copilot-read-only-fixture", private: true })}\n`,
    );
    yield* fs.writeFileString(
      path.join(TOOL_CALL_READ_ONLY_WORKSPACE_ROOT, "tsconfig.json"),
      `${encodeJson({ compilerOptions: { target: "ES2022" } })}\n`,
    );
  }
  const materialized = yield* materializeFixtureInput({
    scenario: fixtureName,
    fixtureInput,
    driver: COPILOT_PROVIDER,
    modelSelection: variant.modelSelection,
  }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
  const scenario = {
    name: `${fixtureName}/copilot-record`,
    commands: materialized.commands,
    // The live CLI needs no replay gates; record dispatches and wait for idle.
    steps: materialized.steps.some(
      (step) =>
        step.type === "release_replay_gate" || step.type === "release_replay_gate_after_waiting",
    )
      ? materialized.steps.filter((step) => step.type === "dispatch")
      : materialized.steps.map((step) =>
          step.type === "finish_held_run" ? { ...step, type: "await_run_status" as const } : step,
        ),
    projectionThreadIds: materialized.projectionThreadIds,
    runtimePolicyOverride: { ...variant.runtimePolicyOverride, cwd: realWorkspace },
  };

  const logDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-copilot-record-" });
  const logPath = path.join(logDir, "wire.ndjson");
  const scriptPath = yield* copilotReplayAgentScript(path);
  const settings = yield* decodeCopilotSettings({
    enabled: true,
    binaryPath: process.env.T3_COPILOT_BIN ?? "copilot",
  });
  const sessions: Array<ProviderAdapter.ProviderAdapterV2SessionRuntime> = [];
  const layerRegistry = ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      const adapter = yield* makeCopilotAdapterV2({
        instanceId: COPILOT_REPLAY_INSTANCE_ID,
        settings,
        environment: process.env,
        createClient: makeScriptedCopilotClient({
          scriptPath,
          env: ({ command }) => ({
            T3_COPILOT_RECORD_TARGET: encodeJson(command),
            T3_COPILOT_RECORD_LOG: logPath,
          }),
        }),
      });
      // Order dispatches on TestClock as in replay, but run the adapter's timers on wall time.
      const onWallClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.provideService(effect, Clock.Clock, wallClock);
      return [
        {
          ...adapter,
          openSession: (input) =>
            adapter.openSession(input).pipe(
              Effect.map((session): ProviderAdapter.ProviderAdapterV2SessionRuntime => {
                sessions.push(session);
                return {
                  ...session,
                  startTurn: (turnInput) => onWallClock(session.startTurn(turnInput)),
                  steerTurn: (turnInput) => onWallClock(session.steerTurn(turnInput)),
                  interruptTurn: (turnInput) => onWallClock(session.interruptTurn(turnInput)),
                  respondToRuntimeRequest: (turnInput) =>
                    onWallClock(session.respondToRuntimeRequest(turnInput)),
                };
              }),
              onWallClock,
            ),
        },
      ];
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
        NodeServices.layer,
        IdAllocator.layer,
      ),
    ),
  );

  // Detached work reports after the turn settles; wait for quiet frames and no pending work.
  let quietPolls = 0;
  let seenFrames = -1;
  const waitForCopilotIdle = Effect.gen(function* () {
    yield* Effect.sleep("1 second");
    const frames = readWire(logPath).length;
    quietPolls = seenFrames === frames ? quietPolls + 1 : 0;
    seenFrames = frames;
    const pending = yield* Effect.forEach(
      sessions,
      (session) => session.hasPendingBackgroundWork ?? Effect.succeed(false),
    );
    return quietPolls >= 4 && !pending.includes(true);
  }).pipe(
    Effect.repeat({ until: (idle) => idle }),
    Effect.timeout("5 minutes"),
    Effect.orDie,
    Effect.asVoid,
    Effect.provideService(Clock.Clock, wallClock),
  );
  const result = yield* runOrchestratorV2Scenario(scenario, {
    afterSteps: waitForCopilotIdle,
  }).pipe(
    Effect.provide(
      ProviderReplayHarness.layerWithRegistry(
        scenario,
        layerRegistry,
        variant.runContinuationWorker === true ? { runContinuationWorker: true } : {},
      ),
    ),
    provideDeterministicTestRuntime,
    Effect.scoped,
  );

  const wire = readWire(logPath);
  const { entries, droppedFrames } = wireToEntries(wire);
  const closedCleanly = entries.some(
    (entry) =>
      entry.type === "expect_outbound" &&
      isRecord(entry.frame) &&
      entry.frame.method === "runtime.shutdown",
  );
  const sessionStart = wire.find((frame) => eventType(frame.message) === "session.start");
  const startData = (sessionStart?.message.params as { event?: { data?: unknown } } | undefined)
    ?.event?.data;
  const transcript = {
    provider: COPILOT_PROVIDER,
    protocol: COPILOT_SDK_JSONRPC_PROTOCOL,
    version: "1",
    scenario: fixtureName,
    metadata: {
      generatedBy: "live-copilot-recorder",
      copilotVersion: isRecord(startData) ? (startData.copilotVersion ?? "unknown") : "unknown",
      normalization:
        "Logical JSON-RPC frames between @github/copilot-sdk and the Copilot CLI. Session ids bind as <$session>, the workspace is <workspace>, HOME is /home/copilot-replay and the recording user is copilot-replay. T3's system message and MCP servers are <any>; the CLI's system prompt is replaced. model.* telemetry, runtime.shutdown, MCP server status, host task events, lifecycle updates and unused streaming deltas are dropped. Event ids and timestamps are kept as recorded.",
      droppedFrames,
    },
    entries: [
      ...normalizeEntries({
        entries,
        workspaces: [...new Set([realWorkspace, workspace])],
        home: process.env.HOME ?? "",
        user: process.env.USER ?? "",
      }),
      { type: "runtime_exit", status: closedCleanly ? "success" : "cancelled" } as const,
    ],
  };

  const outputPath = readArgValues("--out")[0] ?? (yield* path.fromFileUrl(variant.transcriptFile));
  const { entries: transcriptEntries, ...header } = transcript;
  yield* fs.writeFileString(
    outputPath,
    [
      encodeJson({ type: "transcript_start", ...header }),
      ...transcriptEntries.map((entry) => encodeJson(entry)),
      "",
    ].join("\n"),
  );
  const turns = wire.filter(
    (frame) =>
      frame.direction === "out" &&
      (frame.message.method === "session.sendAndWait" || frame.message.method === "session.send"),
  ).length;
  yield* Console.log(
    `Wrote ${transcriptEntries.length} Copilot replay entries (${turns} prompts sent) to ${outputPath}`,
  );

  const liveFailure = yield* Effect.try(() => variant.assertOutput(result, transcript)).pipe(
    Effect.flip,
    Effect.option,
  );
  if (liveFailure._tag === "Some") {
    yield* Console.log(`Live orchestration failed ${fixtureName} assertions:`, liveFailure.value);
  }
});

const scenarios = readArgValues("--scenario").flatMap((value) => value.split(","));
if (scenarios.length === 0) {
  throw new Error("Pass --scenario <fixture name>[,<fixture name>...]");
}

await Effect.runPromise(
  Effect.forEach(scenarios, (name) => Effect.scoped(recordScenario(name)), {
    discard: true,
  }).pipe(Effect.provide(NodeServices.layer)),
);
