import { describe, expect, it } from "vitest";
import { Effect, Ref } from "effect";

import { TextGenerationError } from "../Errors.ts";
import { type TextGenerationShape } from "../Services/TextGeneration.ts";
import { createProviderTextGeneration } from "./ProviderTextGeneration.ts";

function makeStubTextGeneration(tag: "codex" | "claudeAgent", calls: Ref.Ref<string[]>) {
  return {
    generateCommitMessage: () =>
      Ref.update(calls, (current) => [...current, tag]).pipe(
        Effect.as({
          subject: `${tag} subject`,
          body: "",
        }),
      ),
    generatePrContent: () =>
      Ref.update(calls, (current) => [...current, `${tag}:pr`]).pipe(
        Effect.as({
          title: `${tag} title`,
          body: "## Summary\n- ok\n\n## Testing\n- Not run",
        }),
      ),
    generateBranchName: () =>
      Ref.update(calls, (current) => [...current, `${tag}:branch`]).pipe(
        Effect.as({
          branch: `${tag}-branch`,
        }),
      ),
  } satisfies TextGenerationShape;
}

describe("ProviderTextGeneration", () => {
  it("routes by explicit provider and inferred model provider", async () => {
    const calls = await Effect.runPromise(Ref.make<string[]>([]));
    const textGeneration = createProviderTextGeneration(
      makeStubTextGeneration("codex", calls),
      makeStubTextGeneration("claudeAgent", calls),
    );

    await Effect.runPromise(
      textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        provider: "claudeAgent",
        branch: "main",
        stagedSummary: "M a.ts",
        stagedPatch: "diff --git a/a.ts b/a.ts",
      }),
    );
    await Effect.runPromise(
      textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "main",
        stagedSummary: "M b.ts",
        stagedPatch: "diff --git a/b.ts b/b.ts",
        model: "gpt-5.4-mini",
      }),
    );

    expect(await Effect.runPromise(Ref.get(calls))).toEqual(["claudeAgent", "codex"]);
  });

  it("rejects mismatched provider and model combinations", async () => {
    const calls = await Effect.runPromise(Ref.make<string[]>([]));
    const textGeneration = createProviderTextGeneration(
      makeStubTextGeneration("codex", calls),
      makeStubTextGeneration("claudeAgent", calls),
    );

    const result = await Effect.runPromise(
      textGeneration
        .generateCommitMessage({
          cwd: process.cwd(),
          provider: "codex",
          branch: "main",
          stagedSummary: "M a.ts",
          stagedPatch: "diff --git a/a.ts b/a.ts",
          model: "claude-haiku-4-5",
        })
        .pipe(Effect.result),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(TextGenerationError);
      expect(result.failure.message).toContain("does not belong to provider 'codex'");
    }
  });
});
