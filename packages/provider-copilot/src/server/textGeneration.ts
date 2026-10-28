import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { TextGenerationError } from "@t3tools/contracts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";

import type { CopilotSettings } from "../settings.ts";
import {
  buildCopilotClientOptions,
  copilotSessionModelConfig,
  defaultCreateCopilotClient,
  stopCopilotClient,
  switchCopilotModel,
  tryCopilot,
  type CreateCopilotClient,
} from "./runtime.ts";

const COPILOT_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

export const makeCopilotTextGeneration = (
  settings: CopilotSettings,
  environment: NodeJS.ProcessEnv,
  createClient: CreateCopilotClient = defaultCreateCopilotClient,
) => {
  const runCopilotJson: TextGenerationOperations.Runner = Effect.fn(
    "CopilotTextGeneration.runCopilotJson",
  )(
    function* (request) {
      const { operation, cwd, prompt, modelSelection } = request;
      if (!settings.enabled) {
        return yield* new TextGenerationError({
          operation,
          detail: "GitHub Copilot is disabled in T3 Code settings.",
        });
      }
      const clientOptions = yield* buildCopilotClientOptions({ settings, environment, cwd });
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => createClient(clientOptions)),
        stopCopilotClient,
      );
      yield* tryCopilot("Failed to start GitHub Copilot.", () => client.start());
      const model = copilotSessionModelConfig(modelSelection);
      // No tools and no discovered config: background helpers must never touch the workspace.
      const session = yield* Effect.acquireRelease(
        tryCopilot("Failed to create a GitHub Copilot session.", () =>
          client.createSession({
            clientName: "t3-code-text",
            ...model.config,
            workingDirectory: cwd,
            streaming: false,
            availableTools: [],
            enableConfigDiscovery: false,
            infiniteSessions: { enabled: false },
            onPermissionRequest: () => ({ kind: "reject" }),
          }),
        ),
        (session) =>
          Effect.tryPromise(async () => {
            await session.disconnect();
            await client.deleteSession(session.sessionId);
          }).pipe(Effect.ignore),
      );
      if (model.needsSwitch) yield* switchCopilotModel(session, modelSelection);
      const response = yield* tryCopilot("GitHub Copilot text generation failed.", () =>
        session.sendAndWait({ prompt }, COPILOT_TIMEOUT_MS),
      );
      const text = response?.data.content.trim() ?? "";
      if (!text) {
        return yield* new TextGenerationError({
          operation,
          detail: "GitHub Copilot returned empty output.",
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "GitHub Copilot", text);
    },
    (effect, request) => {
      const { operation } = request;
      return effect.pipe(
        Effect.scoped,
        Effect.timeoutOption(COPILOT_TIMEOUT_MS + 10_000),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "GitHub Copilot request timed out." }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail:
                  cause instanceof Error && cause.message
                    ? cause.message
                    : "GitHub Copilot text generation failed.",
                cause,
              }),
        ),
      );
    },
  );

  return Effect.succeed(
    TextGenerationOperations.fromRunner(
      "CopilotTextGeneration",
      TextGenerationOperations.withoutInvestigation("GitHub Copilot", runCopilotJson),
    ),
  );
};
