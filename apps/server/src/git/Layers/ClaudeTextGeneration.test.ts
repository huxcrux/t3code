import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { TextGenerationError } from "../Errors.ts";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";

function makeQuery(messages: ReadonlyArray<SDKMessage>) {
  return () =>
    (async function* () {
      for (const message of messages) {
        yield message;
      }
    })();
}

describe("ClaudeTextGeneration", () => {
  it("generates and sanitizes commit messages", async () => {
    const textGeneration = await Effect.runPromise(
      makeClaudeTextGeneration({
        query: makeQuery([
          {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "",
            structured_output: {
              subject: "Add claude git text generation.",
              body: "- wire provider routing\n- update settings",
              branch: "claude/git-text",
            },
          } as SDKMessage,
        ]),
      }),
    );

    const generated = await Effect.runPromise(
      textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        provider: "claudeAgent",
        branch: "main",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        includeBranch: true,
      }),
    );

    expect(generated.subject).toBe("Add claude git text generation");
    expect(generated.body).toBe("- wire provider routing\n- update settings");
    expect(generated.branch).toBe("feature/claude/git-text");
  });

  it("returns typed errors for invalid structured output", async () => {
    const textGeneration = await Effect.runPromise(
      makeClaudeTextGeneration({
        query: makeQuery([
          {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "",
            structured_output: { wrong: true },
          } as SDKMessage,
        ]),
      }),
    );

    const result = await Effect.runPromise(
      textGeneration
        .generateBranchName({
          cwd: process.cwd(),
          provider: "claudeAgent",
          message: "Fix login button",
        })
        .pipe(Effect.result),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(TextGenerationError);
      expect(result.failure.message).toContain("Claude returned invalid structured output");
    }
  });
});
