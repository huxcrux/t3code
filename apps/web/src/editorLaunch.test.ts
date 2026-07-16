import { describe, expect, it } from "vite-plus/test";

import {
  buildJetBrainsSshUrl,
  buildVSCodeSshUrl,
  buildVSCodeTunnelUrl,
  buildZedSshUrl,
  orderEditorLaunchOptions,
  resolveEditorLaunchOptions,
} from "./editorLaunch";

const SSH_TARGET = {
  alias: "work-box",
  hostname: "10.0.0.8",
  username: "dev user",
  port: 2222,
};

describe("editorLaunch", () => {
  it("builds editor links from the SSH alias while preserving user and port", () => {
    expect(buildVSCodeSshUrl(SSH_TARGET, "/srv/my project")).toBe(
      "vscode://vscode-remote/ssh-remote+dev%20user%40work-box%3A2222/srv/my%20project",
    );
    expect(buildZedSshUrl(SSH_TARGET, "/srv/my project")).toBe(
      "zed://ssh/dev%20user%40work-box%3A2222/srv/my%20project",
    );

    const jetbrains = buildJetBrainsSshUrl(SSH_TARGET, "/srv/my project");
    expect(jetbrains).toContain("host=work-box");
    expect(jetbrains).toContain("user=dev+user");
    expect(jetbrains).toContain("port=2222");
    expect(jetbrains).toContain("projectPath=%2Fsrv%2Fmy+project");
  });

  it("builds VS Code web and desktop tunnel links", () => {
    expect(buildVSCodeTunnelUrl({ machineName: "dev box" }, "/srv/repo", false)).toBe(
      "https://vscode.dev/tunnel/dev%20box/srv/repo",
    );
    expect(buildVSCodeTunnelUrl({ machineName: "dev box" }, "/srv/repo", true)).toBe(
      "vscode://vscode-remote/tunnel+dev%20box/srv/repo",
    );
  });

  it("resolves enabled transports and moves the primary option first", () => {
    const options = resolveEditorLaunchOptions({
      availableLocalEditors: ["zed"],
      sshTarget: SSH_TARGET,
      vscodeTunnel: { machineName: "devbox" },
      remoteEditors: { vscode: true, jetbrains: false, zed: true },
      remotePlatform: { os: "linux", arch: "x64" },
    });
    expect(options.map((option) => option.id)).toEqual([
      "zed",
      "vscode-ssh",
      "zed-ssh",
      "vscode-tunnel",
    ]);
    expect(orderEditorLaunchOptions(options, "zed-ssh").map((option) => option.id)).toEqual([
      "zed-ssh",
      "zed",
      "vscode-ssh",
      "vscode-tunnel",
    ]);
  });

  it("filters remote backends that do not support the target platform", () => {
    const options = resolveEditorLaunchOptions({
      availableLocalEditors: [],
      sshTarget: SSH_TARGET,
      vscodeTunnel: null,
      remoteEditors: { vscode: true, jetbrains: true, zed: true },
      remotePlatform: { os: "windows", arch: "x64" },
    });
    expect(options.map((option) => option.id)).toEqual(["vscode-ssh"]);
  });
});
