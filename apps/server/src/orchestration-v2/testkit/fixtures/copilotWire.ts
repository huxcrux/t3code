import type { ProviderReplayTranscript } from "@t3tools/contracts";

/** Wire labels in order, e.g. `request:session.abort` or `notification:session.event:user.message`. */
export function copilotWireLabels(transcript: ProviderReplayTranscript): ReadonlyArray<string> {
  return transcript.entries.flatMap((entry) =>
    entry.type !== "runtime_exit" && entry.label !== undefined ? [entry.label] : [],
  );
}

export function copilotOutboundParams(
  transcript: ProviderReplayTranscript,
  method: string,
): ReadonlyArray<Readonly<Record<string, unknown>>> {
  return transcript.entries.flatMap((entry) => {
    if (entry.type !== "expect_outbound" || entry.label !== `request:${method}`) return [];
    const params = (entry.frame as { readonly params?: unknown }).params;
    return typeof params === "object" && params !== null
      ? [params as Readonly<Record<string, unknown>>]
      : [];
  });
}
