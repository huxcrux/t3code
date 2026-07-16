import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

function isSafeVSCodeTunnelUrl(url: URL): boolean {
  return (
    url.protocol === "vscode:" &&
    url.hostname === "vscode-remote" &&
    (url.pathname.startsWith("/tunnel+") || url.pathname.startsWith("/ssh-remote+"))
  );
}

function isSafeZedSshUrl(url: URL): boolean {
  return url.protocol === "zed:" && url.hostname === "ssh" && url.pathname.length > 1;
}

function isSafeJetBrainsSshUrl(url: URL): boolean {
  if (url.protocol !== "jetbrains-gateway:" || url.hostname !== "connect") return false;
  const parameters = new URLSearchParams(url.hash.replace(/^#/u, ""));
  const allowedKeys = new Set(["type", "host", "user", "port", "projectPath"]);
  if ([...parameters.keys()].some((key) => !allowedKeys.has(key))) return false;
  if (parameters.get("type") !== "ssh") return false;
  if (!parameters.get("host")?.trim() || !parameters.get("projectPath")?.trim()) return false;
  const port = parameters.get("port");
  return port === null || (/^\d+$/u.test(port) && Number(port) > 0 && Number(port) <= 65_535);
}

export function parseSafeExternalUrl(rawUrl: unknown): Option.Option<string> {
  if (typeof rawUrl !== "string") {
    return Option.none();
  }

  try {
    const url = new URL(rawUrl);
    return SAFE_EXTERNAL_PROTOCOLS.has(url.protocol) ||
      isSafeVSCodeTunnelUrl(url) ||
      isSafeZedSshUrl(url) ||
      isSafeJetBrainsSshUrl(url)
      ? Option.some(url.href)
      : Option.none();
  } catch {
    return Option.none();
  }
}

export class ElectronShell extends Context.Service<
  ElectronShell,
  {
    readonly openExternal: (rawUrl: unknown) => Effect.Effect<boolean>;
    readonly copyText: (text: string) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronShell") {}

export const make = ElectronShell.of({
  openExternal: (rawUrl) =>
    Option.match(parseSafeExternalUrl(rawUrl), {
      onNone: () => Effect.succeed(false),
      onSome: (externalUrl) =>
        Effect.promise(() =>
          Electron.shell.openExternal(externalUrl).then(
            () => true,
            () => false,
          ),
        ),
    }),
  copyText: (text) =>
    Effect.sync(() => {
      Electron.clipboard.writeText(text);
    }),
});

export const layer = Layer.succeed(ElectronShell, make);
