import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  backgroundNotifications,
  projectionFor,
} from "../shared.ts";
import { COPILOT_BACKGROUND_SHELL_PROMPT } from "./input.ts";

export function assertCopilotBackgroundShellOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [COPILOT_BACKGROUND_SHELL_PROMPT]);

  const [rootRun, wakeRun] = projection.runs;
  const commands = projection.turnItems.filter((item) => item.type === "command_execution");
  assert.lengthOf(commands, 1);
  assert.equal(commands[0]?.runId, rootRun?.id, "the command belongs to the run that started it");

  const textsFor = (runId: string | undefined) =>
    projection.turnItems.flatMap((item) =>
      item.runId === runId && item.type === "assistant_message" ? [item.text.trim()] : [],
    );
  assert.include(textsFor(rootRun?.id), "ROOT_DONE");
  assert.include(
    textsFor(wakeRun?.id),
    "BG_DONE",
    "Copilot's reply to the finished shell must land in the continuation run",
  );

  const wakeMessage = projection.messages.find((message) => message.id === wakeRun?.userMessageId);
  assert.equal(`${wakeMessage?.createdBy}:${wakeMessage?.creationSource}`, "agent:provider");
  assert.deepEqual(
    backgroundNotifications(projection).map((notification) => [
      notification.outcome,
      notification.source.kind,
    ]),
    [["completed", "command"]],
  );
}
