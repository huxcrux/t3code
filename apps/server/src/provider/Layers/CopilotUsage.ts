import type { SessionEvent } from "@github/copilot-sdk";
import type {
  RuntimeTaskUsage,
  ThreadTokenUsageSnapshot,
  TurnTokenUsage,
} from "@t3tools/contracts";

type AssistantUsage = Extract<SessionEvent, { type: "assistant.usage" }>["data"];

export interface CopilotUsageTotals {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  cacheCreationTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  durationMs?: number | undefined;
  complete: boolean;
}

export function copilotTokenCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

const sum = (left: number | undefined, right: number | undefined) =>
  left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);

/** Input already includes cache reads/writes; reasoning is a subset of output. */
export function addCopilotUsage(
  previous: CopilotUsageTotals | undefined,
  call: AssistantUsage,
): CopilotUsageTotals {
  const input = copilotTokenCount(call.inputTokens);
  const output = copilotTokenCount(call.outputTokens);
  const reasoning = copilotTokenCount(call.reasoningTokens);
  return {
    inputTokens: sum(previous?.inputTokens, input),
    outputTokens: sum(previous?.outputTokens, output),
    cachedInputTokens: sum(previous?.cachedInputTokens, copilotTokenCount(call.cacheReadTokens)),
    cacheCreationTokens: sum(
      previous?.cacheCreationTokens,
      copilotTokenCount(call.cacheWriteTokens),
    ),
    reasoningTokens: sum(
      previous?.reasoningTokens,
      reasoning === undefined ? undefined : Math.min(output ?? reasoning, reasoning),
    ),
    durationMs: sum(previous?.durationMs, copilotTokenCount(call.duration)),
    complete: (previous?.complete ?? true) && input !== undefined && output !== undefined,
  };
}

export function mergeCopilotUsageTotals(
  previous: CopilotUsageTotals | undefined,
  next: CopilotUsageTotals,
): CopilotUsageTotals {
  return {
    inputTokens: sum(previous?.inputTokens, next.inputTokens),
    outputTokens: sum(previous?.outputTokens, next.outputTokens),
    cachedInputTokens: sum(previous?.cachedInputTokens, next.cachedInputTokens),
    cacheCreationTokens: sum(previous?.cacheCreationTokens, next.cacheCreationTokens),
    reasoningTokens: sum(previous?.reasoningTokens, next.reasoningTokens),
    durationMs: sum(previous?.durationMs, next.durationMs),
    complete: (previous?.complete ?? true) && next.complete,
  };
}

export function copilotTurnTokenUsage(
  usage: CopilotUsageTotals | undefined,
  hasSubagents: boolean,
): TurnTokenUsage {
  const common = {
    usageScope: "main_agent" as const,
    hasSubagents,
    ...(usage?.cachedInputTokens !== undefined
      ? { cachedInputTokens: usage.cachedInputTokens }
      : {}),
    ...(usage?.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: usage.cacheCreationTokens }
      : {}),
    ...(usage?.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
  };
  if (usage?.complete && usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
    return {
      ...common,
      usageStatus: "complete",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
  }
  return {
    ...common,
    usageStatus:
      usage?.inputTokens !== undefined || usage?.outputTokens !== undefined
        ? "partial"
        : "unavailable",
    ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
  };
}

export function copilotTaskUsage(
  usage: CopilotUsageTotals | undefined,
  final?: { totalTokens?: number; totalToolCalls?: number; durationMs?: number },
): RuntimeTaskUsage | undefined {
  const reportedTotal = copilotTokenCount(final?.totalTokens);
  if (
    reportedTotal === undefined &&
    usage?.inputTokens === undefined &&
    usage?.outputTokens === undefined
  )
    return undefined;
  const toolUses = copilotTokenCount(final?.totalToolCalls);
  const durationMs = copilotTokenCount(final?.durationMs) ?? usage?.durationMs;
  return {
    totalTokens: Math.max(
      reportedTotal ?? 0,
      (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
    ),
    ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage?.cachedInputTokens !== undefined
      ? { cachedInputTokens: usage.cachedInputTokens }
      : {}),
    ...(usage?.reasoningTokens !== undefined
      ? { reasoningOutputTokens: usage.reasoningTokens }
      : {}),
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

export function copilotUsageSnapshot(usage: CopilotUsageTotals): ThreadTokenUsageSnapshot {
  const usedTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    ...(usage.inputTokens !== undefined
      ? { inputTokens: usage.inputTokens, lastInputTokens: usage.inputTokens }
      : {}),
    ...(usage.outputTokens !== undefined
      ? { outputTokens: usage.outputTokens, lastOutputTokens: usage.outputTokens }
      : {}),
    ...(usage.cachedInputTokens !== undefined
      ? {
          cachedInputTokens: usage.cachedInputTokens,
          lastCachedInputTokens: usage.cachedInputTokens,
        }
      : {}),
    ...(usage.reasoningTokens !== undefined
      ? { reasoningOutputTokens: usage.reasoningTokens }
      : {}),
    ...(usage.durationMs !== undefined ? { durationMs: usage.durationMs } : {}),
  };
}
