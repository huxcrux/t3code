import type { OrchestratorFixtureInput } from "../shared.ts";

export const COPILOT_BACKGROUND_SUBAGENT_PROMPT =
  "Use the task tool exactly once with mode background to start a general-purpose agent whose only job is to reply exactly CHILD_OK. Do not wait for it or read its result with any tool. As soon as it has started, reply exactly ROOT_DONE.";

export function copilotBackgroundSubagentInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: COPILOT_BACKGROUND_SUBAGENT_PROMPT }],
  };
}
