import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { CopilotSettings } from "../settings.ts";

// One record per model request, including subagent requests, in session-state/<id>/events.jsonl.
const Entry = Schema.Struct({
  type: Schema.Literal("session.usage_record"),
  id: Schema.NonEmptyString,
  timestamp: Schema.String,
  data: Schema.Struct({
    usage: Schema.Struct({
      model: Schema.NonEmptyString,
      inputTokens: Schema.optional(Schema.Unknown),
      outputTokens: Schema.optional(Schema.Unknown),
      cacheReadTokens: Schema.optional(Schema.Unknown),
      cacheWriteTokens: Schema.optional(Schema.Unknown),
      reasoningTokens: Schema.optional(Schema.Unknown),
      accounting: Schema.optional(
        Schema.Struct({ sourceSessionId: Schema.optional(Schema.String) }),
      ),
    }),
  }),
});
const decodeEntry = Schema.decodeUnknownOption(Entry);

function parseRecord(parsed: unknown): readonly UsageRecord[] {
  const decoded = decodeEntry(parsed);
  if (Option.isNone(decoded)) return [];
  const entry = decoded.value;
  const timestampMs = parseTimestampMs(entry.timestamp);
  if (timestampMs === null) return [];
  const { usage } = entry.data;
  // Copilot's input count includes its cache reads and writes.
  const input = tokenCount(usage.inputTokens);
  const cachedInputTokens = Math.min(input, tokenCount(usage.cacheReadTokens));
  const cacheCreationTokens = Math.min(
    input - cachedInputTokens,
    tokenCount(usage.cacheWriteTokens),
  );
  const outputTokens = tokenCount(usage.outputTokens);
  const totals = {
    uncachedInputTokens: input - cachedInputTokens - cacheCreationTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoningTokens)),
  };
  if (totalTokens(totals) === 0) return [];
  return [
    {
      provider: "copilot",
      timestampMs,
      model: usage.model,
      sessionId: usage.accounting?.sourceSessionId ?? "",
      totals,
      reportedCostUsd: null,
      speed: "standard",
      // Forked sessions copy their source's records with the same event ids.
      dedupeKey: `copilot:${entry.id}`,
    },
  ];
}

export const copilotUsageFormat: TranscriptUsageFormat<unknown> = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    data: {
      usage: {
        model: true,
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        reasoningTokens: true,
        accounting: { sourceSessionId: true },
      },
    },
  },
  usageMarkers: ['"session.usage_record"'],
  parseLine: (line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseRecord(parsed);
  },
  parseProjected: parseRecord,
};

export const copilotUsageReader: ProviderUsageReader<CopilotSettings, Path.Path> = {
  kind: "transcripts",
  provider: "copilot",
  format: copilotUsageFormat,
  directories: Effect.fn("copilotUsageReader.directories")(function* ({ environment }) {
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const copilotHome = environment.COPILOT_HOME?.trim();
    return [
      {
        dir: path.resolve(
          copilotHome ? expandHomePath(copilotHome, home) : path.join(home, ".copilot"),
          "session-state",
        ),
        fileName: "events.jsonl",
      },
    ];
  }),
};
