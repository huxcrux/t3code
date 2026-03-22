import {
  query,
  type Options as ClaudeQueryOptions,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { Effect, Layer, Schema } from "effect";

import { TextGenerationError } from "../Errors.ts";
import {
  type BranchNameGenerationResult,
  type CommitMessageGenerationResult,
  type PrContentGenerationResult,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";

const CLAUDE_TIMEOUT_MS = 180_000;

function toClaudeOutputJsonSchema(schema: Schema.Top): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(schema);
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return {
      ...document.schema,
      $defs: document.definitions,
    };
  }
  return document.schema as Record<string, unknown>;
}

function normalizeClaudeError(
  operation: string,
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (Schema.is(TextGenerationError)(error)) {
    return error;
  }

  if (error instanceof Error) {
    return new TextGenerationError({
      operation,
      detail: `${fallback}: ${error.message}`,
      cause: error,
    });
  }

  return new TextGenerationError({
    operation,
    detail: fallback,
    cause: error,
  });
}

function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars);
  return `${truncated}\n\n[truncated]`;
}

function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) {
    return "Update project files";
  }

  if (withoutTrailingPeriod.length <= 72) {
    return withoutTrailingPeriod;
  }
  return withoutTrailingPeriod.slice(0, 72).trimEnd();
}

function sanitizePrTitle(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  return singleLine.length > 0 ? singleLine : "Update project changes";
}

async function collectStructuredOutput(
  messages: AsyncIterable<SDKMessage>,
): Promise<{ structuredOutput: unknown; errorDetail?: string }> {
  let structuredOutput: unknown = undefined;
  let errorDetail: string | undefined = undefined;

  for await (const message of messages) {
    if (message.type !== "result") {
      continue;
    }

    if (message.subtype === "success") {
      structuredOutput = message.structured_output;
      continue;
    }

    if (message.errors.length > 0) {
      errorDetail = message.errors.join(" ");
    }
  }

  return errorDetail === undefined ? { structuredOutput } : { structuredOutput, errorDetail };
}

export interface ClaudeTextGenerationOptions {
  readonly query?: (input: {
    prompt: string;
    options: ClaudeQueryOptions;
  }) => AsyncIterable<SDKMessage>;
}

export const makeClaudeTextGeneration = (options?: ClaudeTextGenerationOptions) =>
  Effect.sync(() => {
    const runClaudeQuery = options?.query ?? ((input) => query(input));
    const runClaudeJson = <S extends Schema.Top>({
      operation,
      cwd,
      prompt,
      outputSchemaJson,
      model,
    }: {
      operation: "generateCommitMessage" | "generatePrContent" | "generateBranchName";
      cwd: string;
      prompt: string;
      outputSchemaJson: S;
      model?: string;
    }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
      Effect.gen(function* () {
        const abortController = new AbortController();

        const runQuery = Effect.tryPromise({
          try: async () => {
            const { structuredOutput, errorDetail } = await collectStructuredOutput(
              runClaudeQuery({
                prompt,
                options: {
                  abortController,
                  cwd,
                  model: model ?? DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.claudeAgent,
                  permissionMode: "plan",
                  tools: [],
                  outputFormat: {
                    type: "json_schema",
                    schema: toClaudeOutputJsonSchema(outputSchemaJson),
                  },
                },
              }),
            );

            if (errorDetail) {
              throw new TextGenerationError({
                operation,
                detail: `Claude SDK command failed: ${errorDetail}`,
              });
            }
            if (structuredOutput === undefined) {
              throw new TextGenerationError({
                operation,
                detail: "Claude returned no structured output.",
              });
            }
            return structuredOutput;
          },
          catch: (error) => normalizeClaudeError(operation, error, "Claude SDK request failed"),
        });

        return yield* runQuery.pipe(
          Effect.timeoutOption(CLAUDE_TIMEOUT_MS),
          Effect.flatMap((result) =>
            result._tag === "Some"
              ? Schema.decodeUnknownEffect(outputSchemaJson)(result.value).pipe(
                  Effect.mapError(
                    (cause) =>
                      new TextGenerationError({
                        operation,
                        detail: "Claude returned invalid structured output.",
                        cause,
                      }),
                  ),
                )
              : Effect.fail(
                  new TextGenerationError({ operation, detail: "Claude SDK request timed out." }),
                ),
          ),
          Effect.ensuring(Effect.sync(() => abortController.abort())),
        );
      });

    const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = (input) => {
      const wantsBranch = input.includeBranch === true;
      const prompt = [
        "You write concise git commit messages.",
        wantsBranch
          ? "Return a JSON object with keys: subject, body, branch."
          : "Return a JSON object with keys: subject, body.",
        "Rules:",
        "- subject must be imperative, <= 72 chars, and no trailing period",
        "- body can be empty string or short bullet points",
        ...(wantsBranch
          ? ["- branch must be a short semantic git branch fragment for this change"]
          : []),
        "- capture the primary user-visible or developer-visible change",
        "",
        `Branch: ${input.branch ?? "(detached)"}`,
        "",
        "Staged files:",
        limitSection(input.stagedSummary, 6_000),
        "",
        "Staged patch:",
        limitSection(input.stagedPatch, 40_000),
      ].join("\n");

      const outputSchemaJson = wantsBranch
        ? Schema.Struct({
            subject: Schema.String,
            body: Schema.String,
            branch: Schema.String,
          })
        : Schema.Struct({
            subject: Schema.String,
            body: Schema.String,
          });

      return runClaudeJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson,
        ...(input.model ? { model: input.model } : {}),
      }).pipe(
        Effect.map(
          (generated) =>
            ({
              subject: sanitizeCommitSubject(generated.subject),
              body: generated.body.trim(),
              ...("branch" in generated && typeof generated.branch === "string"
                ? { branch: sanitizeFeatureBranchName(generated.branch) }
                : {}),
            }) satisfies CommitMessageGenerationResult,
        ),
      );
    };

    const generatePrContent: TextGenerationShape["generatePrContent"] = (input) => {
      const prompt = [
        "You write GitHub pull request content.",
        "Return a JSON object with keys: title, body.",
        "Rules:",
        "- title should be concise and specific",
        "- body must be markdown and include headings '## Summary' and '## Testing'",
        "- under Summary, provide short bullet points",
        "- under Testing, include bullet points with concrete checks or 'Not run' where appropriate",
        "",
        `Base branch: ${input.baseBranch}`,
        `Head branch: ${input.headBranch}`,
        "",
        "Commits:",
        limitSection(input.commitSummary, 12_000),
        "",
        "Diff stat:",
        limitSection(input.diffSummary, 12_000),
        "",
        "Diff patch:",
        limitSection(input.diffPatch, 40_000),
      ].join("\n");

      return runClaudeJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: Schema.Struct({
          title: Schema.String,
          body: Schema.String,
        }),
        ...(input.model ? { model: input.model } : {}),
      }).pipe(
        Effect.map(
          (generated) =>
            ({
              title: sanitizePrTitle(generated.title),
              body: generated.body.trim(),
            }) satisfies PrContentGenerationResult,
        ),
      );
    };

    const generateBranchName: TextGenerationShape["generateBranchName"] = (input) => {
      const attachmentLines = (input.attachments ?? []).map(
        (attachment) =>
          `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
      );

      const promptSections = [
        "You generate concise git branch names.",
        "Return a JSON object with key: branch.",
        "Rules:",
        "- Branch should describe the requested work from the user message.",
        "- Keep it short and specific (2-6 words).",
        "- Use plain words only, no issue prefixes and no punctuation-heavy text.",
        "- If images are attached, rely on attachment metadata only.",
        "",
        "User message:",
        limitSection(input.message, 8_000),
      ];
      if (attachmentLines.length > 0) {
        promptSections.push(
          "",
          "Attachment metadata:",
          limitSection(attachmentLines.join("\n"), 4_000),
        );
      }

      return runClaudeJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt: promptSections.join("\n"),
        outputSchemaJson: Schema.Struct({
          branch: Schema.String,
        }),
        ...(input.model ? { model: input.model } : {}),
      }).pipe(
        Effect.map(
          (generated) =>
            ({
              branch: sanitizeBranchFragment(generated.branch),
            }) satisfies BranchNameGenerationResult,
        ),
      );
    };

    return {
      generateCommitMessage,
      generatePrContent,
      generateBranchName,
    } satisfies TextGenerationShape;
  });

export const ClaudeTextGenerationLive = Layer.effect(TextGeneration, makeClaudeTextGeneration());
