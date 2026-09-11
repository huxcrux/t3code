/** Copilot's durable, session-wide accounting (not its ephemeral context usage). */
import { UsageTokenTotals } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { EMPTY_TOTALS, totalTokens, type UsageRecord } from "./usageTranscripts.ts";

const TokenCount = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const ModelUsage = Schema.Struct({
  inputTokens: TokenCount,
  outputTokens: TokenCount,
  cacheReadTokens: TokenCount,
  cacheWriteTokens: TokenCount,
  reasoningTokens: Schema.optional(TokenCount),
});
const ModelMetric = Schema.Struct({ usage: ModelUsage });
const Metrics = Schema.Struct({ modelMetrics: Schema.Record(Schema.String, Schema.Unknown) });
const Start = Schema.Struct({ sessionId: Schema.NonEmptyString });
const Event = Schema.Struct({
  type: Schema.Literals(["session.start", "session.shutdown", "session.usage_checkpoint"]),
  id: Schema.NonEmptyString,
  timestamp: Schema.String,
  agentId: Schema.optional(Schema.String),
  ephemeral: Schema.optional(Schema.Boolean),
  data: Schema.Unknown,
});
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(Event));
const decodeStart = Schema.decodeUnknownOption(Start);
const decodeMetrics = Schema.decodeUnknownOption(Metrics);
const decodeModelMetric = Schema.decodeUnknownOption(ModelMetric);

const ScanState = Schema.Struct({
  sessionId: Schema.String,
  sawSessionStart: Schema.Boolean,
  usageByModel: Schema.Record(Schema.String, UsageTokenTotals),
});

export interface CopilotScanState {
  sessionId: string;
  sawSessionStart: boolean;
  usageByModel: Readonly<Record<string, UsageTokenTotals>>;
}

/** Invalid persisted state must force a cold parse, not replay cumulative usage. */
export const decodeCopilotScanState = Schema.decodeUnknownOption(ScanState);

export function initialCopilotScanState(sessionId = ""): CopilotScanState {
  return { sessionId, sawSessionStart: false, usageByModel: {} };
}

/**
 * Shutdown metrics include subagents and restore the cumulative baseline on
 * resume. Count only unscoped snapshots, never their agent-scoped counterparts
 * or ephemeral assistant.usage events. A resume does not reset the baseline.
 *
 * SDK 1.0.6 checkpoints contain only totalNanoAiu, NOT tokens. They yield no
 * records; a checkpoint carrying modelMetrics can use the same reducer. Cost
 * multipliers and nano-AIU are not USD. All emitted records use model pricing.
 *
 * Native tokens are visible at shutdown, attributed to that event's time, not
 * to individual requests. Crashes before shutdown can leave an accounting gap.
 */
export function parseCopilotLine(line: string, state: CopilotScanState): readonly UsageRecord[] {
  const decoded = decodeEvent(line);
  if (Option.isNone(decoded)) return [];
  const event = decoded.value;
  if (event.ephemeral || (event.agentId !== undefined && event.agentId !== "")) return [];
  const timestampMs = Date.parse(event.timestamp);
  if (!Number.isFinite(timestampMs)) return [];

  if (event.type === "session.start") {
    const start = decodeStart(event.data);
    // Copied/replayed start events must not change the identity of this file.
    if (!state.sawSessionStart && Option.isSome(start)) {
      state.sessionId = start.value.sessionId;
      state.sawSessionStart = true;
    }
    return [];
  }

  const metrics = decodeMetrics(event.data);
  if (Option.isNone(metrics) || state.sessionId.length === 0) return [];
  const records: UsageRecord[] = [];
  for (const [model, raw] of Object.entries(metrics.value.modelMetrics)) {
    if (model.trim().length === 0) continue;
    const metric = decodeModelMetric(raw);
    if (Option.isNone(metric)) continue;
    const usage = metric.value.usage;
    // Copilot input includes both cache categories; reasoning is within output.
    const current: UsageTokenTotals = {
      uncachedInputTokens: Math.max(
        0,
        usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens,
      ),
      cachedInputTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: Math.min(usage.outputTokens, usage.reasoningTokens ?? 0),
    };
    const previous = Object.hasOwn(state.usageByModel, model)
      ? state.usageByModel[model]!
      : EMPTY_TOTALS;
    const totals: UsageTokenTotals = {
      uncachedInputTokens: Math.max(0, current.uncachedInputTokens - previous.uncachedInputTokens),
      cachedInputTokens: Math.max(0, current.cachedInputTokens - previous.cachedInputTokens),
      cacheCreationTokens: Math.max(0, current.cacheCreationTokens - previous.cacheCreationTokens),
      outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
      reasoningTokens: Math.min(
        Math.max(0, current.outputTokens - previous.outputTokens),
        Math.max(0, current.reasoningTokens - previous.reasoningTokens),
      ),
    };
    // Keep high-water marks: duplicate or older snapshots cannot lower the
    // baseline and cause the next shutdown to charge those tokens again.
    // Replace the map so the reader's shallow tail-state clone stays isolated.
    state.usageByModel = {
      ...state.usageByModel,
      [model]: {
        uncachedInputTokens: Math.max(previous.uncachedInputTokens, current.uncachedInputTokens),
        cachedInputTokens: Math.max(previous.cachedInputTokens, current.cachedInputTokens),
        cacheCreationTokens: Math.max(previous.cacheCreationTokens, current.cacheCreationTokens),
        outputTokens: Math.max(previous.outputTokens, current.outputTokens),
        reasoningTokens: Math.max(previous.reasoningTokens, current.reasoningTokens),
      },
    };
    if (totalTokens(totals) === 0) continue;
    records.push({
      provider: "copilot",
      timestampMs,
      model,
      sessionId: state.sessionId,
      totals,
      reportedCostUsd: null,
      dedupeKey: JSON.stringify(["copilot", state.sessionId, event.id, model]),
    });
  }
  return records;
}
