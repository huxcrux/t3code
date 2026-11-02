import type { OrchestratorFixtureInput } from "../shared.ts";

export const COPILOT_BACKGROUND_SHELL_PROMPT =
  "Use the bash tool exactly once with mode async and detach true to run: sleep 8 && echo BG_TICK. Do not wait for it, read its output, or call any other tool. As soon as it has started, reply exactly ROOT_DONE. When you are told it finished, reply exactly BG_DONE.";

/** Copilot settles the turn while the detached shell runs, then wakes itself when it exits. */
export function copilotBackgroundShellInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: COPILOT_BACKGROUND_SHELL_PROMPT },
      { type: "await_run_status", targetRunIndex: 2, status: "completed" },
    ],
  };
}
