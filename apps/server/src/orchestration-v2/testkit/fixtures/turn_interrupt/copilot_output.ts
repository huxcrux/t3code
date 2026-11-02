import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { copilotWireLabels } from "../copilotWire.ts";
import { assertTurnInterruptOutput } from "./codex_output.ts";

/** Stop pressed right after send reaches Copilot before it registers the prompt. */
export function assertCopilotTurnInterruptOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertTurnInterruptOutput(result, transcript);
  const labels = copilotWireLabels(transcript);
  const send = labels.indexOf("request:session.sendAndWait");
  const abort = labels.indexOf("request:session.abort");
  assert.isAtLeast(send, 0);
  assert.isAbove(abort, send);
  for (const event of ["user.message", "assistant.message", "tool.execution_start"]) {
    assert.notInclude(
      labels,
      `notification:session.event:${event}`,
      `Copilot must drop a prompt stopped before it started (${event})`,
    );
  }
  assert.isAbove(labels.indexOf("notification:session.event:session.idle"), abort);
}
