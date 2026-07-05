import { type ServerVSCodeTunnel, type ServerVSCodeTunnelStatus } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "./processRunner.ts";

const VSCODE_TUNNEL_STATUS_TIMEOUT = Duration.millis(1_500);

const VSCodeTunnelStatusJson = Schema.Struct({
  tunnel: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      tunnel: Schema.optional(Schema.String),
    }),
  ),
  service_installed: Schema.optional(Schema.Boolean),
});

const decodeVSCodeTunnelStatusJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(VSCodeTunnelStatusJson),
);

function extractVSCodeTunnelStatusJson(stdout: string): string {
  const trimmed = stdout.trim();
  const jsonLine =
    trimmed
      .split(/\r?\n/)
      .find((line) => line.trim().startsWith("{"))
      ?.trim() ?? "";
  return jsonLine || trimmed;
}

const UNCHECKED_STATUS: ServerVSCodeTunnelStatus = {
  checked: false,
  connected: false,
  machineName: null,
  serviceInstalled: null,
};

const CHECKED_UNAVAILABLE_STATUS: ServerVSCodeTunnelStatus = {
  checked: true,
  connected: false,
  machineName: null,
  serviceInstalled: null,
};

export interface ResolvedVSCodeTunnel {
  readonly tunnel: ServerVSCodeTunnel | null;
  readonly status: ServerVSCodeTunnelStatus;
}

export const resolveVSCodeTunnel = Effect.fn("vscodeTunnel.resolve")(function* (input: {
  readonly enabled: boolean;
}) {
  if (!input.enabled) {
    return {
      tunnel: null,
      status: UNCHECKED_STATUS,
    } satisfies ResolvedVSCodeTunnel;
  }

  const runner = yield* ProcessRunner.ProcessRunner;
  const result = yield* runner
    .run({
      command: "code",
      args: ["tunnel", "status"],
      timeout: VSCODE_TUNNEL_STATUS_TIMEOUT,
      maxOutputBytes: 16 * 1024,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.option);

  if (Option.isNone(result)) {
    return {
      tunnel: null,
      status: CHECKED_UNAVAILABLE_STATUS,
    } satisfies ResolvedVSCodeTunnel;
  }
  const output = result.value;
  if (output.timedOut || output.code !== 0) {
    return {
      tunnel: null,
      status: CHECKED_UNAVAILABLE_STATUS,
    } satisfies ResolvedVSCodeTunnel;
  }

  const decoded = decodeVSCodeTunnelStatusJson(extractVSCodeTunnelStatusJson(output.stdout));
  if (Option.isNone(decoded)) {
    return {
      tunnel: null,
      status: CHECKED_UNAVAILABLE_STATUS,
    } satisfies ResolvedVSCodeTunnel;
  }
  const tunnel = decoded.value.tunnel;
  const machineName = tunnel?.name?.trim() ?? "";
  const connected = Boolean(machineName) && tunnel?.tunnel?.toLowerCase() === "connected";
  const status: ServerVSCodeTunnelStatus = {
    checked: true,
    connected,
    machineName: machineName || null,
    serviceInstalled: decoded.value.service_installed ?? null,
  };

  if (!connected) {
    return {
      tunnel: null,
      status,
    } satisfies ResolvedVSCodeTunnel;
  }

  return {
    tunnel: {
      machineName,
    },
    status,
  } satisfies ResolvedVSCodeTunnel;
});
