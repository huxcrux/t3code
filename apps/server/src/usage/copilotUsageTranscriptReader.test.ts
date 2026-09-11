// @effect-diagnostics nodeBuiltinImport:off - byte-exact append/rotation fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";

import { decodeScanCache, encodeScanCache, type ScanCache } from "./usageScanCache.ts";
import { listTranscriptFiles, readTranscriptRecords } from "./usageTranscriptReader.ts";

let dir: string;

beforeEach(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "copilot-usage-reader-"));
});

afterEach(async () => {
  await NodeFSP.rm(dir, { recursive: true, force: true });
});

const start = `${JSON.stringify({
  type: "session.start",
  id: "start",
  timestamp: "2026-08-01T09:00:00Z",
  data: { sessionId: "native-session" },
})}\n`;

function shutdown(scale: number): string {
  return `${JSON.stringify({
    type: "session.shutdown",
    id: `shutdown-${scale}`,
    timestamp: "2026-08-01T10:00:00Z",
    data: {
      modelMetrics: {
        "gpt-5": {
          usage: {
            inputTokens: 100 * scale,
            outputTokens: 10 * scale,
            cacheReadTokens: 20 * scale,
            cacheWriteTokens: 5 * scale,
          },
        },
      },
    },
  })}\n`;
}

describe("Copilot incremental transcript reader", () => {
  it("round-trips cumulative cache state and re-reads a complete unterminated tail exactly once", async () => {
    const path = NodePath.join(dir, "events.jsonl");
    await NodeFSP.writeFile(path, start + shutdown(1) + shutdown(2).trimEnd());
    const first = await readTranscriptRecords(path, "copilot");
    assert.isNotNull(first);
    assert.deepStrictEqual(
      first.records.map((record) => record.totals.outputTokens),
      [10],
    );
    assert.deepStrictEqual(
      first.tailRecords.map((record) => record.totals.outputTokens),
      [10],
    );
    assert.strictEqual(first.position.copilotState?.usageByModel["gpt-5"]?.outputTokens, 10);

    const stats = await NodeFSP.stat(path);
    const cache: ScanCache = new Map([
      [
        path,
        {
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          provider: "copilot",
          records: first.records,
          tailRecords: first.tailRecords,
          position: first.position,
        },
      ],
    ]);
    const restored = decodeScanCache(JSON.parse(JSON.stringify(encodeScanCache(cache))));
    assert.deepStrictEqual(restored.get(path), cache.get(path));
    const position = restored.get(path)?.position;
    assert.isDefined(position);

    await NodeFSP.appendFile(path, `\n${shutdown(2)}${shutdown(3)}`);
    const second = await readTranscriptRecords(path, "copilot", position);
    const full = await readTranscriptRecords(path, "copilot");
    assert.isNotNull(second);
    assert.isNotNull(full);
    assert.isTrue(second.resumed);
    assert.deepStrictEqual(
      second.records.map((record) => record.totals.outputTokens),
      [10, 10],
    );
    assert.deepStrictEqual([...first.records, ...second.records], full.records);
    assert.deepStrictEqual(second.tailRecords, []);
    // Resuming must not mutate the cached position supplied by the caller.
    assert.strictEqual(position.copilotState?.usageByModel["gpt-5"]?.outputTokens, 10);
  });

  it("does not advance cumulative state for an incomplete JSON tail", async () => {
    const path = NodePath.join(dir, "events.jsonl");
    const next = shutdown(2);
    const splitAt = Math.floor(next.length / 2);
    await NodeFSP.writeFile(path, start + shutdown(1) + next.slice(0, splitAt));
    const first = await readTranscriptRecords(path, "copilot");
    assert.isNotNull(first);
    assert.deepStrictEqual(first.tailRecords, []);
    await NodeFSP.appendFile(path, next.slice(splitAt));
    const second = await readTranscriptRecords(path, "copilot", first.position);
    assert.isNotNull(second);
    assert.isTrue(second.resumed);
    assert.strictEqual(second.records[0]?.totals.outputTokens, 10);
  });

  it("cold parses when state is absent or the file was rewritten", async () => {
    const path = NodePath.join(dir, "events.jsonl");
    await NodeFSP.writeFile(path, start + shutdown(3));
    const first = await readTranscriptRecords(path, "copilot");
    assert.isNotNull(first);
    const { copilotState: _state, ...legacyPosition } = first.position;
    const legacy = await readTranscriptRecords(path, "copilot", legacyPosition);
    assert.isNotNull(legacy);
    assert.isFalse(legacy.resumed);
    assert.deepStrictEqual(legacy.records, first.records);

    await NodeFSP.writeFile(path, start + shutdown(1) + shutdown(2));
    const rewritten = await readTranscriptRecords(path, "copilot", first.position);
    assert.isNotNull(rewritten);
    assert.isFalse(rewritten.resumed);
    assert.deepStrictEqual(
      rewritten.records.map((record) => record.totals.outputTokens),
      [10, 10],
    );
  });

  it("rejects Copilot cache entries with missing or corrupt baselines", async () => {
    const path = NodePath.join(dir, "events.jsonl");
    await NodeFSP.writeFile(path, start + shutdown(1));
    const parsed = await readTranscriptRecords(path, "copilot");
    assert.isNotNull(parsed);
    const encoded = encodeScanCache(
      new Map([
        [
          path,
          {
            size: 1000,
            mtimeMs: 100,
            provider: "copilot",
            records: parsed.records,
            tailRecords: [],
            position: parsed.position,
          },
        ],
      ]),
    );
    for (const cps of [
      undefined,
      null,
      { sessionId: 42 },
      {
        sessionId: "native-session",
        sawSessionStart: true,
        usageByModel: { "gpt-5": { ...parsed.records[0]!.totals, outputTokens: -1 } },
      },
    ]) {
      const corrupt = { ...encoded, files: { [path]: { ...encoded.files[path], cps } } };
      assert.strictEqual(decodeScanCache(JSON.parse(JSON.stringify(corrupt))).size, 0);
    }
  });

  it("uses the native session directory as identity when the start event is unavailable", async () => {
    const sessionDir = NodePath.join(dir, "session-state", "fallback-session");
    await NodeFSP.mkdir(sessionDir, { recursive: true });
    const path = NodePath.join(sessionDir, "events.jsonl");
    await NodeFSP.writeFile(path, shutdown(1));
    await NodeFSP.writeFile(NodePath.join(sessionDir, "other.jsonl"), shutdown(100));
    const files = await listTranscriptFiles(dir, 0, { fileName: "events.jsonl" });
    assert.deepStrictEqual(
      files.map((file) => file.path),
      [path],
    );
    const parsed = await readTranscriptRecords(path, "copilot");
    assert.isNotNull(parsed);
    assert.strictEqual(parsed.records[0]?.sessionId, "fallback-session");
  });
});
