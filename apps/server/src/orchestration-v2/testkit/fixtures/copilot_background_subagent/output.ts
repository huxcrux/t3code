import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { COPILOT_BACKGROUND_SUBAGENT_PROMPT } from "./input.ts";

/** Copilot's `session.idle` waits for background agents, so the child settles inside the run. */
export function assertCopilotBackgroundSubagentOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [COPILOT_BACKGROUND_SUBAGENT_PROMPT]);

  const [rootRun] = projection.runs;
  const children = projection.nodes.filter((node) => node.kind === "subagent");
  assert.lengthOf(children, 1);
  assert.equal(children[0]?.status, "completed");
  const childCompletedAt = result.domainEvents.findIndex(
    (event) =>
      event.type === "node.updated" &&
      event.payload.id === children[0]?.id &&
      event.payload.status === "completed",
  );
  const rootCompletedAt = result.domainEvents.findIndex(
    (event) =>
      event.type === "run.updated" &&
      event.payload.id === rootRun?.id &&
      event.payload.status === "completed",
  );
  assert.isAtLeast(childCompletedAt, 0);
  assert.isAbove(rootCompletedAt, childCompletedAt, "the run must outlast its background child");
  const rootReplies = projection.turnItems.flatMap((item) =>
    item.runId === rootRun?.id && item.type === "assistant_message" ? [item.text.trim()] : [],
  );
  // Copilot wakes itself on `agent_idle` and answers from the child's result before idling.
  assert.equal(rootReplies[0], "ROOT_DONE");
  assert.equal(rootReplies.at(-1), "CHILD_OK");
}
