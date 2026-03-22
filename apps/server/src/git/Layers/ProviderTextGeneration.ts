import { DEFAULT_GIT_TEXT_GENERATION_PROVIDER, type ProviderKind } from "@t3tools/contracts";
import { inferProviderForModel } from "@t3tools/shared/model";
import { Effect, Layer } from "effect";

import { TextGenerationError } from "../Errors.ts";
import {
  type BranchNameGenerationInput,
  type CommitMessageGenerationInput,
  type PrContentGenerationInput,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";

export interface ProviderTextGenerationOptions {
  readonly codex?: TextGenerationShape;
  readonly claude?: TextGenerationShape;
}

export function createProviderTextGeneration(
  codex: TextGenerationShape,
  claude: TextGenerationShape,
): TextGenerationShape {
  const route = (
    operation: string,
    provider: ProviderKind | undefined,
    model: string | undefined,
  ): Effect.Effect<TextGenerationShape, TextGenerationError> =>
    validateProvider(operation, provider, model).pipe(
      Effect.map((resolvedProvider) => (resolvedProvider === "claudeAgent" ? claude : codex)),
    );

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = (
    input: CommitMessageGenerationInput,
  ) =>
    route("generateCommitMessage", input.provider, input.model).pipe(
      Effect.flatMap((implementation) => implementation.generateCommitMessage(input)),
    );

  const generatePrContent: TextGenerationShape["generatePrContent"] = (
    input: PrContentGenerationInput,
  ) =>
    route("generatePrContent", input.provider, input.model).pipe(
      Effect.flatMap((implementation) => implementation.generatePrContent(input)),
    );

  const generateBranchName: TextGenerationShape["generateBranchName"] = (
    input: BranchNameGenerationInput,
  ) =>
    route("generateBranchName", input.provider, input.model).pipe(
      Effect.flatMap((implementation) => implementation.generateBranchName(input)),
    );

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
  };
}

function resolveProvider(
  provider: ProviderKind | undefined,
  model: string | undefined,
): ProviderKind {
  return provider ?? inferProviderForModel(model, DEFAULT_GIT_TEXT_GENERATION_PROVIDER);
}

function validateProvider(
  operation: string,
  provider: ProviderKind | undefined,
  model: string | undefined,
): Effect.Effect<ProviderKind, TextGenerationError> {
  const resolvedProvider = resolveProvider(provider, model);
  if (provider && model && inferProviderForModel(model, provider) !== provider) {
    return Effect.fail(
      new TextGenerationError({
        operation,
        detail: `Model '${model}' does not belong to provider '${provider}'.`,
      }),
    );
  }
  return Effect.succeed(resolvedProvider);
}

export const makeProviderTextGeneration = (options?: ProviderTextGenerationOptions) =>
  Effect.gen(function* () {
    const codex = options?.codex ?? (yield* makeCodexTextGeneration);
    const claude = options?.claude ?? (yield* makeClaudeTextGeneration());
    return createProviderTextGeneration(codex, claude);
  });

export const ProviderTextGenerationLive = Layer.effect(
  TextGeneration,
  makeProviderTextGeneration(),
);
