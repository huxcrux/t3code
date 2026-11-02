import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderReplayEntry,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import { CopilotSettings } from "@t3tools/provider-copilot/settings";
import {
  COPILOT_PROVIDER,
  makeCopilotAdapterV2,
  makeScriptedCopilotClient,
} from "@t3tools/provider-copilot/testing";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";

export const COPILOT_SDK_JSONRPC_PROTOCOL = "copilot-sdk-jsonrpc";

export const CopilotReplayTranscript = Schema.Struct({
  provider: ProviderDriverKind,
  protocol: Schema.Literal(COPILOT_SDK_JSONRPC_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ProviderReplayEntry),
});
export type CopilotReplayTranscript = typeof CopilotReplayTranscript.Type;

export class CopilotReplayTranscriptDecodeError extends Schema.TaggedError<CopilotReplayTranscriptDecodeError>()(
  "CopilotReplayTranscriptDecodeError",
  { scenario: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to decode Copilot replay transcript for scenario ${this.scenario}.`;
  }
}

const decodeCopilotReplayTranscriptSchema = Schema.decodeUnknownEffect(CopilotReplayTranscript);
const decodeCopilotReplayTranscript = (transcript: ProviderReplayTranscript) =>
  decodeCopilotReplayTranscriptSchema(transcript).pipe(
    Effect.filterOrFail(
      (decoded) => decoded.provider === COPILOT_PROVIDER,
      () => `Expected provider ${COPILOT_PROVIDER}, received ${transcript.provider}`,
    ),
    Effect.mapError(
      (cause) => new CopilotReplayTranscriptDecodeError({ scenario: transcript.scenario, cause }),
    ),
  );

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeStatus = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      cursor: Schema.Number,
      total: Schema.Number,
      failure: Schema.optional(Schema.Unknown),
    }),
  ),
);

export const COPILOT_REPLAY_INSTANCE_ID = ProviderInstanceId.make("copilot");
const COPILOT_REPLAY_SETTINGS = Schema.decodeSync(CopilotSettings)({
  enabled: true,
  binaryPath: process.execPath,
});

export const copilotReplayAgentScript = (path: Path.Path) =>
  path.fromFileUrl(new URL("../../../scripts/copilot-replay-agent.ts", import.meta.url));

function layerCopilotProviderAdapterRegistryReplay(transcript: CopilotReplayTranscript) {
  return ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const replayDir = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: `t3-copilot-replay-${transcript.scenario}-` })
        .pipe(Effect.orDie);
      const transcriptPath = path.join(replayDir, "transcript.json");
      const statusPath = path.join(replayDir, "status.json");
      yield* fileSystem.writeFileString(transcriptPath, encodeJson(transcript)).pipe(Effect.orDie);
      const scriptPath = yield* copilotReplayAgentScript(path).pipe(Effect.orDie);
      yield* Effect.addFinalizer(() =>
        fileSystem.readFileString(statusPath).pipe(
          Effect.map(decodeStatus),
          Effect.flatMap((status) =>
            status.failure === undefined && status.cursor === transcript.entries.length
              ? Effect.void
              : Effect.die(
                  `Copilot replay ${transcript.scenario} stopped at ${status.cursor}/${transcript.entries.length}: ${encodeJson(status.failure ?? transcript.entries[status.cursor])}`,
                ),
          ),
          Effect.orDie,
        ),
      );
      const adapter = yield* makeCopilotAdapterV2({
        instanceId: COPILOT_REPLAY_INSTANCE_ID,
        settings: COPILOT_REPLAY_SETTINGS,
        environment: {},
        createClient: makeScriptedCopilotClient({
          scriptPath,
          env: ({ cwd }) => ({
            T3_COPILOT_REPLAY_TRANSCRIPT_PATH: transcriptPath,
            T3_COPILOT_REPLAY_STATUS_PATH: statusPath,
            ...(cwd === undefined ? {} : { T3_COPILOT_REPLAY_WORKSPACE: cwd }),
          }),
        }),
      });
      return [adapter];
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
}

export const CopilotOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  CopilotReplayTranscript,
  CopilotReplayTranscriptDecodeError
> = {
  driver: COPILOT_PROVIDER,
  decodeTranscript: decodeCopilotReplayTranscript,
  makeProviderAdapterRegistryLayer: layerCopilotProviderAdapterRegistryReplay,
};
