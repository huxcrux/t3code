import type { ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import type { DesktopSshEnvironmentTarget, ServerSshServerStatus } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { isLoopbackHostname } from "./environments/primary/target";

const DESKTOP_LOCAL_CONNECTION_ID_PREFIX = "local:";

export function canLaunchLocalEditors(input: {
  readonly entry: ConnectionCatalogEntry;
  readonly isElectron: boolean;
  readonly locationHostname: string;
}): boolean {
  const target = input.entry.target;
  if (input.isElectron) {
    return (
      target._tag === "PrimaryConnectionTarget" ||
      (target._tag === "BearerConnectionTarget" &&
        target.connectionId.startsWith(DESKTOP_LOCAL_CONNECTION_ID_PREFIX))
    );
  }

  return target._tag === "PrimaryConnectionTarget" && isLoopbackHostname(input.locationHostname);
}

function hostnameFromUrl(rawUrl: string | null): string | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Resolves the SSH identity that native editors should use. An SSH connection
 * profile is authoritative because it was resolved from the client machine's
 * OpenSSH configuration. Direct web connections may fall back to the same host
 * used by T3, but only after the backend confirms a loopback SSH listener.
 * Local launch contexts stay disabled unless the explicit testing preference is
 * on, then use an override or a detected localhost SSH server.
 */
export function resolveEditorSshTarget(input: {
  readonly entry: ConnectionCatalogEntry;
  readonly displayUrl: string | null;
  readonly locationHostname: string;
  readonly isElectron: boolean;
  readonly sshServerStatus: ServerSshServerStatus;
  readonly sshAliasOverride?: string | null;
  readonly allowLocalTesting?: boolean;
}): DesktopSshEnvironmentTarget | null {
  const aliasOverride = input.sshAliasOverride?.trim();
  const localLaunchContext = canLaunchLocalEditors(input);

  if (localLaunchContext) {
    if (!input.allowLocalTesting) return null;

    if (aliasOverride) {
      return {
        alias: aliasOverride,
        hostname: aliasOverride,
        username: null,
        port: null,
      };
    }

    if (!input.sshServerStatus.running) return null;
    return {
      alias: "localhost",
      hostname: "localhost",
      username: null,
      port: input.sshServerStatus.port === 22 ? null : input.sshServerStatus.port,
    };
  }

  if (aliasOverride) {
    return {
      alias: aliasOverride,
      hostname: aliasOverride,
      username: null,
      port: null,
    };
  }

  const profile = Option.getOrNull(input.entry.profile);
  if (profile?._tag === "SshConnectionProfile") {
    return profile.target;
  }

  if (input.isElectron || !input.sshServerStatus.running) {
    return null;
  }

  const target = input.entry.target;
  if (target._tag === "RelayConnectionTarget") {
    return null;
  }

  const connectionHostname =
    target._tag === "PrimaryConnectionTarget"
      ? input.locationHostname
      : hostnameFromUrl(input.displayUrl);
  if (!connectionHostname || isLoopbackHostname(connectionHostname)) {
    return null;
  }

  return {
    alias: connectionHostname,
    hostname: connectionHostname,
    username: null,
    port: input.sshServerStatus.port === 22 ? null : input.sshServerStatus.port,
  };
}
