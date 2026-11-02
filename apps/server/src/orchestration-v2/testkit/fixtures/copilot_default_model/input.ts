import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";

import { COPILOT_MODEL_SELECTION, type OrchestratorFixtureInput } from "../shared.ts";

/** Copilot lists `auto` as its own model and T3 marks it as the default. */
export const COPILOT_DEFAULT_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("copilot"),
  model: "auto",
} satisfies ModelSelection;

export const COPILOT_DEFAULT_MODEL_PROMPTS = [
  "Reply exactly: named model one",
  "Reply exactly: default model one",
  "Reply exactly: named model two",
  "Reply exactly: default model resumed",
] as const;

/** Named, default, named, then default again after the idle release resumes the session. */
export function copilotDefaultModelInput(): OrchestratorFixtureInput {
  const [namedOne, defaultOne, namedTwo, defaultResumed] = COPILOT_DEFAULT_MODEL_PROMPTS;
  return {
    steps: [
      { type: "message", text: namedOne, modelSelection: COPILOT_MODEL_SELECTION },
      { type: "message", text: defaultOne },
      { type: "message", text: namedTwo, modelSelection: COPILOT_MODEL_SELECTION },
      { type: "advance_clock", duration: "31 minutes" },
      { type: "message", text: defaultResumed },
    ],
  };
}
