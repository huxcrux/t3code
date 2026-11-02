import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { copilotOutboundParams } from "../copilotWire.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  COPILOT_MODEL_SELECTION,
  projectionFor,
} from "../shared.ts";
import { COPILOT_DEFAULT_MODEL_PROMPTS, COPILOT_DEFAULT_MODEL_SELECTION } from "./input.ts";

export function assertCopilotDefaultModelOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const named = COPILOT_MODEL_SELECTION.model;
  const fallback = COPILOT_DEFAULT_MODEL_SELECTION.model;
  assert.deepEqual(
    copilotOutboundParams(transcript, "session.create").map((params) => params.model),
    [named],
  );
  assert.deepEqual(
    copilotOutboundParams(transcript, "session.model.switchTo").map((params) => params.modelId),
    [fallback, named],
    "the live session must switch back to the default after a named model ran",
  );
  assert.deepEqual(
    copilotOutboundParams(transcript, "session.resume").map((params) => params.model),
    [fallback],
    "the resumed session must start on the default, not the last named model",
  );

  assertBaseProjection({
    result,
    transcript,
    runCount: 4,
    runStatuses: ["completed", "completed", "completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, COPILOT_DEFAULT_MODEL_PROMPTS);
  assert.deepEqual(
    projection.runs.map((run) => run.modelSelection.model),
    [named, fallback, named, fallback],
  );
  const answers = projection.turnItems.flatMap((item) =>
    item.type === "assistant_message" ? [item.text.trim()] : [],
  );
  assert.deepEqual(answers, [
    "named model one",
    "default model one",
    "named model two",
    "default model resumed",
  ]);
}
