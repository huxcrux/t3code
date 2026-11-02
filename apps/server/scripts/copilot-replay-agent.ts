#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// Stands in for the Copilot CLI behind the real @github/copilot-sdk. The SDK speaks
// vscode-jsonrpc (Content-Length framed) over stdio; this replays a recorded transcript,
// or with T3_COPILOT_RECORD_TARGET set, proxies to the real CLI and logs every frame.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

interface ReplayEntry {
  readonly type: "emit_inbound" | "expect_outbound" | "runtime_exit";
  readonly label?: string;
  readonly frame?: unknown;
  readonly status?: "success" | "error" | "cancelled";
  readonly error?: unknown;
}

interface ReplayTranscript {
  readonly scenario: string;
  readonly entries: ReadonlyArray<ReplayEntry>;
}

interface LogicalFrame {
  readonly kind: "notification" | "request" | "response";
  readonly method: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface JsonRpcMessage {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

function frameReader(onMessage: (body: string) => void): (chunk: Buffer) => void {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const length = /Content-Length: *(\d+)/i.exec(buffer.subarray(0, headerEnd).toString());
      if (length === null) throw new Error("Copilot frame has no Content-Length header");
      const start = headerEnd + 4;
      const end = start + Number(length[1]);
      if (buffer.length < end) return;
      const body = buffer.subarray(start, end).toString("utf8");
      buffer = buffer.subarray(end);
      onMessage(body);
    }
  };
}

function encodeFrame(message: JsonRpcMessage): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function runRecordProxy(target: string, logPath: string): void {
  const [command, ...args] = JSON.parse(target) as ReadonlyArray<string>;
  const child = NodeChildProcess.spawn(command!, [...args, ...process.argv.slice(2)], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const log = (direction: "in" | "out", body: string) =>
    NodeFS.appendFileSync(
      logPath,
      `${JSON.stringify({ pid: process.pid, direction, message: JSON.parse(body) })}\n`,
    );
  const toCli = frameReader((body) => {
    log("out", body);
    child.stdin.write(encodeFrame(JSON.parse(body) as JsonRpcMessage));
  });
  const toSdk = frameReader((body) => {
    log("in", body);
    process.stdout.write(encodeFrame(JSON.parse(body) as JsonRpcMessage));
  });
  process.stdin.on("data", toCli);
  process.stdin.on("end", () => child.stdin.end());
  child.stdout.on("data", toSdk);
  child.on("exit", (code) => process.exit(code ?? 0));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

const recordTarget = process.env.T3_COPILOT_RECORD_TARGET;
const recordLog = process.env.T3_COPILOT_RECORD_LOG;
if (recordTarget !== undefined && recordLog !== undefined) {
  runRecordProxy(recordTarget, recordLog);
} else {
  runReplay();
}

function runReplay(): void {
  const transcriptPath = process.env.T3_COPILOT_REPLAY_TRANSCRIPT_PATH;
  const statusPath = process.env.T3_COPILOT_REPLAY_STATUS_PATH;
  const replayWorkspace = process.env.T3_COPILOT_REPLAY_WORKSPACE ?? process.cwd();
  if (transcriptPath === undefined || statusPath === undefined) {
    process.stderr.write("Copilot replay requires transcript and status environment variables.\n");
    process.exit(2);
  }
  const transcript = JSON.parse(NodeFS.readFileSync(transcriptPath, "utf8")) as ReplayTranscript;
  // A restarted CLI process (idle release, resume) continues the same transcript.
  const previous = NodeFS.existsSync(statusPath)
    ? (JSON.parse(NodeFS.readFileSync(statusPath, "utf8")) as {
        readonly cursor: number;
        readonly bindings: Record<string, string>;
        readonly failure?: unknown;
      })
    : undefined;
  if (previous?.failure !== undefined) process.exit(1);
  let cursor = previous?.cursor ?? 0;
  const bindings = new Map(Object.entries(previous?.bindings ?? {}));
  let stopped = false;
  const pendingRequestIds = new Map<string, Array<string | number>>();

  function writeStatus(failure?: unknown): void {
    const temporaryStatusPath = `${statusPath}.${process.pid}.tmp`;
    NodeFS.writeFileSync(
      temporaryStatusPath,
      JSON.stringify({
        scenario: transcript.scenario,
        cursor,
        total: transcript.entries.length,
        bindings: Object.fromEntries(bindings),
        ...(failure === undefined ? {} : { failure }),
      }),
      "utf8",
    );
    NodeFS.renameSync(temporaryStatusPath, statusPath!);
  }

  function expand(value: string): string {
    return value
      .replaceAll("<workspace>", replayWorkspace)
      .replace(/<\$(\w+)>/g, (placeholder, name: string) => bindings.get(name) ?? placeholder);
  }

  // `<$name>` binds to the first actual value and must match it afterwards.
  function matchesExpected(
    expected: unknown,
    actual: unknown,
    bound: Map<string, string>,
  ): boolean {
    if (expected === "<any>") return true;
    if (typeof expected === "string" && typeof actual === "string") {
      const binding = /^<\$(\w+)>$/.exec(expected)?.[1];
      if (binding !== undefined && !bindings.has(binding)) {
        const existing = bound.get(binding);
        if (existing !== undefined) return existing === actual;
        bound.set(binding, actual);
        return true;
      }
      const expanded = expand(expected);
      if (!expanded.includes("<any>")) return expanded === actual;
      let offset = 0;
      for (const part of expanded.split("<any>")) {
        const index = actual.indexOf(part, offset);
        if (index === -1) return false;
        offset = index + part.length;
      }
      return true;
    }
    if (Array.isArray(expected)) {
      return (
        Array.isArray(actual) &&
        expected.length === actual.length &&
        expected.every((entry, index) => matchesExpected(entry, actual[index], bound))
      );
    }
    if (typeof expected === "object" && expected !== null) {
      if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
      const expectedRecord = expected as Record<string, unknown>;
      const actualRecord = actual as Record<string, unknown>;
      const expectedKeys = Object.keys(expectedRecord).toSorted();
      const actualKeys = Object.keys(actualRecord).toSorted();
      return (
        expectedKeys.join("\0") === actualKeys.join("\0") &&
        expectedKeys.every((key) => matchesExpected(expectedRecord[key], actualRecord[key], bound))
      );
    }
    return Object.is(expected, actual);
  }

  function stopWithFailure(detail: string, actual?: unknown): void {
    if (stopped) return;
    stopped = true;
    const failure = {
      detail,
      cursor,
      expected: transcript.entries[cursor],
      ...(actual === undefined ? {} : { actual }),
    };
    writeStatus(failure);
    // Exiting fails the SDK's pending requests, so the scenario stops instead of timing out.
    process.stderr.write(`Copilot replay mismatch: ${JSON.stringify(failure)}\n`, () =>
      process.exit(1),
    );
  }

  function materialize(value: unknown): unknown {
    if (typeof value === "string") return expand(value);
    if (Array.isArray(value)) return value.map(materialize);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, materialize(entry)]),
    );
  }

  function inboundMessage(recorded: LogicalFrame): JsonRpcMessage | undefined {
    const frame = materialize(recorded) as LogicalFrame;
    if (frame.kind === "notification") {
      return { jsonrpc: "2.0", method: frame.method, params: frame.params };
    }
    if (frame.kind === "response") {
      const id = pendingRequestIds.get(frame.method)?.shift();
      if (id === undefined) {
        stopWithFailure(`No pending SDK request for ${frame.method}`, frame);
        return undefined;
      }
      return {
        jsonrpc: "2.0",
        id,
        ...(frame.error === undefined ? { result: frame.result ?? null } : { error: frame.error }),
      };
    }
    stopWithFailure("The Copilot CLI sends no requests in this protocol", frame);
    return undefined;
  }

  // Record progress before publishing, since the SDK may kill this process after its last reply.
  function flushInbound(): void {
    if (stopped) return;
    const messages: Array<JsonRpcMessage> = [];
    for (;;) {
      const entry = transcript.entries[cursor];
      if (entry === undefined || entry.type === "expect_outbound") break;
      cursor += 1;
      // The recorded CLI process ended here; the next process resumes after it.
      if (entry.type === "runtime_exit") break;
      const message = inboundMessage(entry.frame as LogicalFrame);
      if (message === undefined) break;
      messages.push(message);
    }
    if (!stopped) writeStatus();
    for (const message of messages) process.stdout.write(encodeFrame(message));
  }

  function handleMessage(message: JsonRpcMessage): void {
    if (stopped) return;
    if (typeof message.method !== "string") {
      stopWithFailure("The SDK answered a request the replay never sent", message);
      return;
    }
    const isRequest = message.id !== undefined && message.id !== null;
    const actual: LogicalFrame = {
      kind: isRequest ? "request" : "notification",
      method: message.method,
      ...(message.params === undefined ? {} : { params: message.params }),
    };
    // Teardown can arrive after the next CLI process started, so it is not in the transcript.
    if (message.method === "runtime.shutdown" && isRequest) {
      process.stdout.write(encodeFrame({ jsonrpc: "2.0", id: message.id!, result: null }));
      return;
    }
    const entry = transcript.entries[cursor];
    const bound = new Map<string, string>();
    if (entry?.type !== "expect_outbound" || !matchesExpected(entry.frame, actual, bound)) {
      stopWithFailure("Unexpected outbound Copilot frame", actual);
      if (isRequest) {
        process.stdout.write(
          encodeFrame({
            jsonrpc: "2.0",
            id: message.id!,
            error: { code: -32603, message: "Copilot replay frame mismatch" },
          }),
        );
      }
      return;
    }
    for (const [name, value] of bound) bindings.set(name, value);
    if (isRequest) {
      const queue = pendingRequestIds.get(message.method) ?? [];
      queue.push(message.id!);
      pendingRequestIds.set(message.method, queue);
    }
    cursor += 1;
    flushInbound();
  }

  flushInbound();
  process.stdin.on(
    "data",
    frameReader((body) => {
      try {
        handleMessage(JSON.parse(body) as JsonRpcMessage);
      } catch (cause) {
        stopWithFailure("Failed to decode outbound Copilot JSON-RPC", String(cause));
      }
    }),
  );
}
