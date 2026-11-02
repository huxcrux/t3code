import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TOOL_CALL_WRITE_PROMPT,
} from "../shared.ts";

/** Full access approves Copilot's permission prompts without asking the user. */
export function assertCopilotToolCallWorkspaceNeverOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [TOOL_CALL_WRITE_PROMPT]);
  assertRuntimeRequestCounts(projection, { total: 0 });
  const writes = projection.turnItems.filter(
    (item) => item.type === "file_change" || item.type === "command_execution",
  );
  assert.isNotEmpty(writes, "Copilot must write the probe file");
  assert.isTrue(
    writes.every((item) => item.status === "completed"),
    "the write must succeed without an approval",
  );
  assert.include(JSON.stringify(writes), ".codex-probe-write-action.txt");
}
