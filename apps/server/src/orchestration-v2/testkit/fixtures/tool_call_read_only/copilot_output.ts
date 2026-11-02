import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TOOL_CALL_READ_ONLY_PROMPT,
} from "../shared.ts";

export function assertCopilotToolCallReadOnlyOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [TOOL_CALL_READ_ONLY_PROMPT]);
  assertAssistantTextIncludes(projection, "read only tool fixture complete");
  assertRuntimeRequestCounts(projection, { total: 0 });

  const tools = projection.turnItems.filter(
    (item) => item.type !== "user_message" && item.type !== "assistant_message",
  );
  assert.isNotEmpty(tools, "Copilot must read the files with a tool");
  assert.isTrue(
    tools.every((item) => "status" in item && item.status === "completed"),
    "every read must complete",
  );
  const output = JSON.stringify(tools);
  assert.include(output, "copilot-read-only-fixture");
  assert.include(output, "ES2022");
  assert.notInclude(
    projection.turnItems.map((item) => item.type),
    "file_change",
    "a read-only prompt must not write",
  );
}
