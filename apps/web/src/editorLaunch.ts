import {
  EditorId,
  type DesktopSshEnvironmentTarget,
  type EditorLaunchPreferenceId,
  type ExecutionEnvironmentPlatform,
  type RemoteEditorAvailability,
  type ServerVSCodeTunnel,
} from "@t3tools/contracts";

export type LocalEditorLaunchOption = {
  readonly id: EditorId;
  readonly kind: "local";
  readonly editor: EditorId;
};

export type SshEditorLaunchOption = {
  readonly id: "vscode-ssh" | "jetbrains-ssh" | "zed-ssh";
  readonly kind: "ssh";
  readonly target: DesktopSshEnvironmentTarget;
};

export type VSCodeTunnelLaunchOption = {
  readonly id: "vscode-tunnel";
  readonly kind: "tunnel";
  readonly tunnel: ServerVSCodeTunnel;
};

export type EditorLaunchOption =
  | LocalEditorLaunchOption
  | SshEditorLaunchOption
  | VSCodeTunnelLaunchOption;

function encodeRemotePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const hasLeadingSlash = normalized.startsWith("/");
  const encodedSegments = normalized
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join("/");
  return hasLeadingSlash ? `/${encodedSegments}` : encodedSegments;
}

export function sshAuthority(target: DesktopSshEnvironmentTarget): string {
  const host = target.alias.trim() || target.hostname.trim();
  const user = target.username?.trim();
  const port = target.port;
  return `${user ? `${user}@` : ""}${host}${port === null ? "" : `:${port}`}`;
}

export function buildVSCodeSshUrl(target: DesktopSshEnvironmentTarget, path: string): string {
  return `vscode://vscode-remote/ssh-remote+${encodeURIComponent(sshAuthority(target))}${encodeRemotePath(path)}`;
}

export function buildZedSshUrl(target: DesktopSshEnvironmentTarget, path: string): string {
  return `zed://ssh/${encodeURIComponent(sshAuthority(target))}${encodeRemotePath(path)}`;
}

export function buildJetBrainsSshUrl(target: DesktopSshEnvironmentTarget, path: string): string {
  const parameters = new URLSearchParams({
    type: "ssh",
    host: target.alias.trim() || target.hostname.trim(),
    projectPath: path,
  });
  const user = target.username?.trim();
  if (user) parameters.set("user", user);
  if (target.port !== null) parameters.set("port", String(target.port));
  return `jetbrains-gateway://connect#${parameters.toString()}`;
}

export function buildVSCodeTunnelUrl(
  tunnel: ServerVSCodeTunnel,
  path: string,
  desktop: boolean,
): string {
  const encodedPath = encodeRemotePath(path);
  return desktop
    ? `vscode://vscode-remote/tunnel+${encodeURIComponent(tunnel.machineName)}${encodedPath}`
    : `https://vscode.dev/tunnel/${encodeURIComponent(tunnel.machineName)}/${encodedPath.replace(/^\//u, "")}`;
}

export function resolveEditorLaunchOptions(input: {
  readonly availableLocalEditors: ReadonlyArray<EditorId>;
  readonly sshTarget: DesktopSshEnvironmentTarget | null;
  readonly vscodeTunnel: ServerVSCodeTunnel | null;
  readonly remoteEditors: RemoteEditorAvailability;
  readonly remotePlatform: ExecutionEnvironmentPlatform | null;
}): ReadonlyArray<EditorLaunchOption> {
  const options: EditorLaunchOption[] = input.availableLocalEditors.map((editor) => ({
    id: editor,
    kind: "local",
    editor,
  }));

  if (input.sshTarget) {
    if (input.remoteEditors.vscode) {
      options.push({ id: "vscode-ssh", kind: "ssh", target: input.sshTarget });
    }
    if (
      input.remoteEditors.jetbrains &&
      input.remotePlatform?.os === "linux" &&
      input.remotePlatform.arch === "x64"
    ) {
      options.push({ id: "jetbrains-ssh", kind: "ssh", target: input.sshTarget });
    }
    if (input.remoteEditors.zed && input.remotePlatform?.os !== "windows") {
      options.push({ id: "zed-ssh", kind: "ssh", target: input.sshTarget });
    }
  }

  if (input.vscodeTunnel && input.remoteEditors.vscode) {
    options.push({ id: "vscode-tunnel", kind: "tunnel", tunnel: input.vscodeTunnel });
  }

  return options;
}

export function orderEditorLaunchOptions(
  options: ReadonlyArray<EditorLaunchOption>,
  primaryEditor: EditorLaunchPreferenceId | null,
): ReadonlyArray<EditorLaunchOption> {
  if (primaryEditor === null) return options;
  const preferred = options.find((option) => option.id === primaryEditor);
  return preferred ? [preferred, ...options.filter((option) => option !== preferred)] : options;
}
