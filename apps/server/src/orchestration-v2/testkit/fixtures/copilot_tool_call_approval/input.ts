import type { OrchestratorFixtureInput } from "../shared.ts";

export const COPILOT_APPROVED_WRITE_TARGET = ".copilot-approved-write.txt";
export const COPILOT_DENIED_WRITE_TARGET = ".copilot-denied-write.txt";

const writePrompt = (target: string) =>
  `Use the create tool once to create ${target} containing exactly: approval fixture. If permission is denied, do not retry or use another tool; reply exactly: write permission denied. Otherwise reply exactly: write permission granted. Do not read any files, use the shell, network, or MCP.`;

export const COPILOT_APPROVED_WRITE_PROMPT = writePrompt(COPILOT_APPROVED_WRITE_TARGET);
export const COPILOT_DENIED_WRITE_PROMPT = writePrompt(COPILOT_DENIED_WRITE_TARGET);

/** Copilot derives approvals from the runtime mode alone, not a sandbox or approval policy. */
export function copilotToolCallApprovalInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "approval-required",
    steps: [
      { type: "message", text: COPILOT_APPROVED_WRITE_PROMPT },
      { type: "approve_next_runtime_request", decision: "accept" },
    ],
  };
}

export function copilotToolCallDeclinedInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "approval-required",
    steps: [
      { type: "message", text: COPILOT_DENIED_WRITE_PROMPT },
      { type: "approve_next_runtime_request", decision: "decline" },
    ],
  };
}
