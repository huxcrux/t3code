import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import { totalTokens } from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import { copilotUsageFormat, copilotUsageReader } from "./usage.ts";

const entry = (usage: Record<string, unknown> = {}) => ({
  type: "session.usage_record",
  id: "event-1",
  parentId: "event-0",
  timestamp: "2026-08-01T10:00:00.123Z",
  data: {
    usage: {
      model: "claude-sonnet-4.5",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 60,
      cacheWriteTokens: 10,
      reasoningTokens: 8,
      cost: 1,
      accounting: { sourceSessionId: "session-1", usageId: "usage-1" },
      ...usage,
    },
  },
});
const parse = (value: unknown) => copilotUsageFormat.parseLine(JSON.stringify(value), undefined);

describe("copilotUsageFormat", () => {
  it("splits inclusive input counts into uncached, cached and cache-write tokens", () => {
    const [record] = parse(entry());
    expect(record).toMatchObject({
      provider: "copilot",
      timestampMs: Date.parse("2026-08-01T10:00:00.123Z"),
      sessionId: "session-1",
      model: "claude-sonnet-4.5",
      reportedCostUsd: null,
      totals: {
        uncachedInputTokens: 30,
        cachedInputTokens: 60,
        cacheCreationTokens: 10,
        outputTokens: 20,
        reasoningTokens: 8,
      },
    });
    expect(totalTokens(record!.totals)).toBe(120);
  });

  it("dedupes a request copied into a forked session by its event id", () => {
    const [original] = parse(entry());
    const [copy] = parse(entry({ accounting: { sourceSessionId: "session-1" } }));
    expect(copy?.dedupeKey).toBe(original?.dedupeKey);
    expect(parse({ ...entry(), id: "event-2" })[0]?.dedupeKey).not.toBe(original?.dedupeKey);
  });

  it("ignores other events, empty usage and malformed lines", () => {
    expect(parse({ ...entry(), type: "assistant.usage" })).toEqual([]);
    expect(
      parse(
        entry({
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        }),
      ),
    ).toEqual([]);
    expect(copilotUsageFormat.parseLine("{not json", undefined)).toEqual([]);
  });
});

describe("copilotUsageReader", () => {
  const directories = (environment: NodeJS.ProcessEnv) =>
    copilotUsageReader.kind === "transcripts"
      ? copilotUsageReader
          .directories({
            instanceId: ProviderInstanceId.make("copilot"),
            config: undefined,
            environment,
            configured: true,
          })
          .pipe(
            Effect.provideService(HostProcess.HomeDirectory, "/home/me"),
            Effect.provide(NodeServices.layer),
          )
      : Effect.die("Copilot usage reads transcripts");

  it.effect("reads session-state from COPILOT_HOME or ~/.copilot", () =>
    Effect.gen(function* () {
      expect(yield* directories({})).toEqual([
        { dir: "/home/me/.copilot/session-state", fileName: "events.jsonl" },
      ]);
      expect(yield* directories({ COPILOT_HOME: "~/work-copilot" })).toEqual([
        { dir: "/home/me/work-copilot/session-state", fileName: "events.jsonl" },
      ]);
    }),
  );
});
