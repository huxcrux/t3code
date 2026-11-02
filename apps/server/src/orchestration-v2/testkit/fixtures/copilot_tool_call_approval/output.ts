import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { copilotOutboundParams, copilotWireLabels } from "../copilotWire.ts";
import {
  assertAllRuntimeRequestsResolved,
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertRuntimeRequestKinds,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
} from "../shared.ts";
import {
  COPILOT_APPROVED_WRITE_PROMPT,
  COPILOT_APPROVED_WRITE_TARGET,
  COPILOT_DENIED_WRITE_PROMPT,
  COPILOT_DENIED_WRITE_TARGET,
} from "./input.ts";

function assertWriteApproval(input: {
  readonly result: OrchestratorV2ScenarioResult;
  readonly transcript: ProviderReplayTranscript;
  readonly prompt: string;
  readonly target: string;
  readonly decision: "accept" | "decline";
}) {
  const { result, transcript, decision } = input;
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [input.prompt]);
  assertRuntimeRequestCounts(projection, { total: 1, resolved: 1 });
  assertRuntimeRequestKinds(projection, ["file-change"]);
  assertAllRuntimeRequestsResolved(projection);
  assert.deepEqual(
    projection.runtimeRequests.map((request) => request.decision),
    [decision],
  );
  assert.deepEqual(
    copilotOutboundParams(transcript, "session.permissions.handlePendingPermissionRequest").map(
      (params) => (params.result as { readonly kind?: unknown } | undefined)?.kind,
    ),
    [decision === "accept" ? "approve-once" : "reject"],
    "the decision must reach Copilot",
  );

  const writes = projection.turnItems.filter((item) => item.type === "file_change");
  assert.lengthOf(writes, 1);
  assert.include(writes[0]?.fileName ?? "", input.target);
  assert.equal(writes[0]?.status, decision === "accept" ? "completed" : "failed");
  if (decision === "accept") {
    assertAssistantTextIncludes(projection, "write permission granted");
    return;
  }
  // Copilot ends its own turn after a rejected tool call instead of replying.
  const labels = copilotWireLabels(transcript);
  assert.isAbove(
    labels.indexOf("notification:session.event:abort"),
    labels.indexOf("request:session.permissions.handlePendingPermissionRequest"),
  );
  assert.notInclude(labels, "request:session.abort");
}

export function assertCopilotToolCallApprovalOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertWriteApproval({
    result,
    transcript,
    prompt: COPILOT_APPROVED_WRITE_PROMPT,
    target: COPILOT_APPROVED_WRITE_TARGET,
    decision: "accept",
  });
}

export function assertCopilotToolCallDeclinedOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertWriteApproval({
    result,
    transcript,
    prompt: COPILOT_DENIED_WRITE_PROMPT,
    target: COPILOT_DENIED_WRITE_TARGET,
    decision: "decline",
  });
}
