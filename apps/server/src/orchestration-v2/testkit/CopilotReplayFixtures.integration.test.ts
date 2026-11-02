import { describe } from "@effect/vitest";

import { CopilotOrchestratorReplayHarness } from "../Adapters/CopilotAdapterV2.testkit.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

describe("Copilot replay fixtures", () => {
  itRunsReplayFixtures("copilot", (input) =>
    runReplayFixture({ ...input, harness: CopilotOrchestratorReplayHarness }),
  );
});
