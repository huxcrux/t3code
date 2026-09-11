import { describe, expect, it } from "@effect/vitest";

import { initialCopilotScanState, parseCopilotLine } from "./copilotUsageTranscripts.ts";
import { UsageAggregator } from "./usageAggregation.ts";
import { createOverrideRateTable, parseRateTable } from "./usagePricing.ts";
import { mightCarryUsage, totalTokens } from "./usageTranscripts.ts";

function event(
  type: string,
  data: unknown,
  envelope: { id?: string; timestamp?: string; agentId?: string; ephemeral?: boolean } = {},
): string {
  return JSON.stringify({
    type,
    id: "event-1",
    timestamp: "2026-08-01T10:00:00Z",
    parentId: null,
    data,
    ...envelope,
  });
}

function metric(scale = 1) {
  return {
    requests: { count: scale, cost: 100 * scale },
    totalNanoAiu: 9_000_000_000 * scale,
    usage: {
      inputTokens: 1_000 * scale,
      cacheReadTokens: 200 * scale,
      cacheWriteTokens: 100 * scale,
      outputTokens: 50 * scale,
      reasoningTokens: 20 * scale,
    },
  };
}

function snapshot(
  modelMetrics: unknown,
  envelope: Parameters<typeof event>[2] = {},
  type = "session.shutdown",
) {
  return event(type, { modelMetrics, totalNanoAiu: 99_000_000_000, currentTokens: 42 }, envelope);
}

describe("Copilot native transcript accounting", () => {
  it("counts disjoint token categories and never treats billing units as USD", () => {
    const state = initialCopilotScanState();
    expect(parseCopilotLine(event("session.start", { sessionId: "s-1" }), state)).toEqual([]);
    const [record] = parseCopilotLine(snapshot({ "gpt-5": metric() }), state);
    expect(record).toMatchObject({
      provider: "copilot",
      sessionId: "s-1",
      model: "gpt-5",
      timestampMs: Date.parse("2026-08-01T10:00:00Z"),
      reportedCostUsd: null,
      totals: {
        uncachedInputTokens: 700,
        cachedInputTokens: 200,
        cacheCreationTokens: 100,
        outputTokens: 50,
        reasoningTokens: 20,
      },
    });
    expect(totalTokens(record!.totals)).toBe(1050);
  });

  it("deltas per model across checkpoints, shutdowns and resume without resetting", () => {
    const state = initialCopilotScanState("s-1");
    const first = parseCopilotLine(
      snapshot({ "gpt-5": metric(), "claude-sonnet-4": metric(2) }, {}, "session.usage_checkpoint"),
      state,
    );
    expect(first.map((record) => totalTokens(record.totals))).toEqual([1050, 2100]);
    expect(parseCopilotLine(snapshot({ "gpt-5": metric() }, { id: "shutdown-1" }), state)).toEqual(
      [],
    );
    expect(
      parseCopilotLine(event("session.resume", { resumeTime: "2026-08-02T09:00:00Z" }), state),
    ).toEqual([]);
    const next = parseCopilotLine(
      snapshot({ "gpt-5": metric(3), "claude-sonnet-4": metric(3) }, { id: "shutdown-2" }),
      state,
    );
    expect(next.map((record) => totalTokens(record.totals))).toEqual([2100, 1050]);
    expect(parseCopilotLine(snapshot({ "gpt-5": metric(3) }, { id: "repeated" }), state)).toEqual(
      [],
    );
  });

  it("ignores nano-AIU-only checkpoints without changing token baselines", () => {
    const state = initialCopilotScanState("s-1");
    parseCopilotLine(snapshot({ "gpt-5": metric() }), state);
    const before = structuredClone(state);
    expect(
      parseCopilotLine(event("session.usage_checkpoint", { totalNanoAiu: 999 }), state),
    ).toEqual([]);
    expect(state).toEqual(before);
    expect(
      parseCopilotLine(snapshot({ "gpt-5": metric(2) }, { id: "next" }), state)[0]?.totals
        .outputTokens,
    ).toBe(50);
  });

  it("ignores ephemeral and agent-scoped metrics already included in root shutdown", () => {
    const state = initialCopilotScanState("s-1");
    const before = structuredClone(state);
    for (const line of [
      event("assistant.usage", { model: "gpt-5", ...metric().usage }, { ephemeral: true }),
      event("session.usage_info", { currentTokens: 999_999 }),
      event("session.start", { sessionId: "child" }, { agentId: "worker" }),
      snapshot({ "gpt-5": metric(100) }, { agentId: "worker" }),
      snapshot({ "gpt-5": metric(100) }, { ephemeral: true }),
    ]) {
      expect(parseCopilotLine(line, state)).toEqual([]);
    }
    expect(state).toEqual(before);
    expect(parseCopilotLine(snapshot({ "gpt-5": metric() }), state)[0]?.totals.outputTokens).toBe(
      50,
    );
  });

  it("keeps high-water marks when stale snapshots reappear", () => {
    const state = initialCopilotScanState("s-1");
    parseCopilotLine(snapshot({ "gpt-5": metric(3) }), state);
    expect(parseCopilotLine(snapshot({ "gpt-5": metric() }, { id: "old" }), state)).toEqual([]);
    expect(
      parseCopilotLine(snapshot({ "gpt-5": metric(4) }, { id: "new" }), state)[0]?.totals
        .outputTokens,
    ).toBe(50);
  });

  it("does not let malformed snapshots consume a baseline or discard valid sibling models", () => {
    const state = initialCopilotScanState("s-1");
    const invalidUsage = [
      null,
      {},
      { ...metric().usage, inputTokens: -1 },
      { ...metric().usage, outputTokens: "50" },
    ];
    for (const usage of invalidUsage) {
      expect(parseCopilotLine(snapshot({ "gpt-5": { usage } }), state)).toEqual([]);
    }
    for (const line of [
      "{",
      "null",
      "[]",
      snapshot({ "gpt-5": metric() }, { timestamp: "invalid" }),
    ]) {
      expect(parseCopilotLine(line, state)).toEqual([]);
    }
    const records = parseCopilotLine(
      snapshot({ "gpt-5": metric(), bad: null, "": metric() }),
      state,
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.totals.outputTokens).toBe(50);
  });

  it("uses only the first main session identity and accepts the directory ID as fallback", () => {
    const state = initialCopilotScanState("directory-session");
    parseCopilotLine(event("session.start", { sessionId: "native-session" }), state);
    parseCopilotLine(event("session.start", { sessionId: "copied-ancestor" }), state);
    expect(parseCopilotLine(snapshot({ "gpt-5": metric() }), state)[0]?.sessionId).toBe(
      "native-session",
    );
    const fallback = initialCopilotScanState("directory-session");
    expect(parseCopilotLine(snapshot({ "gpt-5": metric() }), fallback)[0]?.sessionId).toBe(
      "directory-session",
    );
  });

  it("keeps model and session identity in cross-file dedupe keys", () => {
    const first = parseCopilotLine(
      snapshot({ "gpt-5": metric(), "claude-sonnet-4": metric() }),
      initialCopilotScanState("s-1"),
    );
    const copy = parseCopilotLine(snapshot({ "gpt-5": metric() }), initialCopilotScanState("s-1"));
    const other = parseCopilotLine(snapshot({ "gpt-5": metric() }), initialCopilotScanState("s-2"));
    expect(first[0]?.dedupeKey).toBe(copy[0]?.dedupeKey);
    expect(new Set([...first, ...other].map((record) => record.dedupeKey)).size).toBe(3);
  });

  it("gates on native accounting events, not tool output or context counters", () => {
    for (const type of ["session.start", "session.shutdown", "session.usage_checkpoint"]) {
      expect(mightCarryUsage(event(type, {}), "copilot")).toBe(true);
    }
    for (const type of ["assistant.message", "assistant.usage", "session.usage_info"]) {
      expect(mightCarryUsage(event(type, {}), "copilot")).toBe(false);
    }
  });
});

describe("Copilot usage aggregation", () => {
  it("prices snapshot deltas in their reporting window and dedupes copied transcripts", () => {
    const state = initialCopilotScanState("s-1");
    const old = parseCopilotLine(snapshot({ "gpt-5": metric() }), state);
    const current = parseCopilotLine(
      snapshot(
        { "gpt-5": metric(2), unknown: metric() },
        { id: "shutdown-2", timestamp: "2026-08-02T10:15:00Z" },
      ),
      state,
    );
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-02",
      untilDay: "2026-08-02",
      resolution: "hour",
      sinceTimeMs: Date.parse("2026-08-02T10:00:00Z"),
      untilTimeMs: Date.parse("2026-08-02T11:00:00Z"),
      rates: parseRateTable({
        "gpt-5": {
          input_cost_per_token: 2e-6,
          output_cost_per_token: 8e-6,
          cache_read_input_token_cost: 0.5e-6,
          cache_creation_input_token_cost: 3e-6,
        },
      }),
    });
    for (const record of [...old, ...current, ...current]) aggregator.add(record);
    const result = aggregator.finish();
    expect(result.duplicatesDropped).toBe(2);
    expect(result.outOfWindow).toBe(1);
    const priced = result.buckets.find((bucket) => bucket.model === "gpt-5");
    expect(priced).toMatchObject({
      provider: "copilot",
      costSource: "modelPriced",
      records: 1,
      sessions: 1,
      hourStart: "2026-08-02T10:00:00.000Z",
    });
    expect(priced?.costUsd).toBeCloseTo(0.0022, 10);
    expect(priced?.cacheSavingsUsd).toBeCloseTo(0.0003, 10);
    expect(result.buckets.find((bucket) => bucket.model === "unknown")).toMatchObject({
      costUsd: 0,
      costSource: "unpriced",
      unpricedRecords: 1,
    });
  });

  it("honors existing custom USD token prices for Copilot model IDs", () => {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-01",
      rates: new Map(),
      priceOverrides: createOverrideRateTable({
        custom: { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
      }),
    });
    const records = parseCopilotLine(
      snapshot({ custom: metric() }),
      initialCopilotScanState("s-1"),
    );
    for (const record of records) aggregator.add(record);
    expect(aggregator.finish().buckets[0]).toMatchObject({
      costSource: "modelPriced",
      unpricedRecords: 0,
    });
    expect(aggregator.finish().buckets[0]?.costUsd).toBeCloseTo(0.0024, 10);
  });
});
