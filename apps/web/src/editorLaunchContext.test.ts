import {
  PrimaryConnectionTarget,
  SshConnectionProfile,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { canLaunchLocalEditors, resolveEditorSshTarget } from "./editorLaunchContext";

const environmentId = EnvironmentId.make("environment-1");
const localEntry = {
  target: new PrimaryConnectionTarget({
    environmentId,
    label: "Local",
    httpBaseUrl: "http://127.0.0.1:3773",
    wsBaseUrl: "ws://127.0.0.1:3773",
  }),
  profile: Option.none(),
};

const sshTarget = {
  alias: "work-box",
  hostname: "10.0.0.8",
  username: "dev",
  port: 2222,
};
const sshEntry = {
  target: new SshConnectionTarget({
    environmentId,
    label: "Remote",
    connectionId: "ssh:environment-1",
  }),
  profile: Option.some(
    new SshConnectionProfile({
      connectionId: "ssh:environment-1",
      environmentId,
      label: "Remote",
      target: sshTarget,
    }),
  ),
};

describe("editorLaunchContext", () => {
  it("only exposes local editors to local launch contexts", () => {
    expect(
      canLaunchLocalEditors({
        entry: localEntry,
        isElectron: false,
        locationHostname: "localhost",
      }),
    ).toBe(true);
    expect(
      canLaunchLocalEditors({
        entry: localEntry,
        isElectron: false,
        locationHostname: "dev.example.com",
      }),
    ).toBe(false);
    expect(
      canLaunchLocalEditors({ entry: sshEntry, isElectron: true, locationHostname: "localhost" }),
    ).toBe(false);
  });

  it("reuses the authoritative T3 SSH profile", () => {
    expect(
      resolveEditorSshTarget({
        entry: sshEntry,
        displayUrl: null,
        locationHostname: "localhost",
        isElectron: true,
        sshServerStatus: { checked: true, running: false, port: 22 },
      }),
    ).toEqual(sshTarget);
  });

  it("uses the direct T3 hostname only after local sshd detection", () => {
    expect(
      resolveEditorSshTarget({
        entry: localEntry,
        displayUrl: null,
        locationHostname: "dev.example.com",
        isElectron: false,
        sshServerStatus: { checked: true, running: true, port: 22 },
      }),
    ).toEqual({
      alias: "dev.example.com",
      hostname: "dev.example.com",
      username: null,
      port: null,
    });
  });

  it("allows an explicit machine SSH config alias for non-default ports", () => {
    expect(
      resolveEditorSshTarget({
        entry: localEntry,
        displayUrl: null,
        locationHostname: "dev.example.com",
        isElectron: false,
        sshServerStatus: { checked: true, running: false, port: 22 },
        sshAliasOverride: "work-cluster",
      }),
    ).toEqual({
      alias: "work-cluster",
      hostname: "work-cluster",
      username: null,
      port: null,
    });
  });

  it("keeps remote editor launchers hidden for local clients by default", () => {
    expect(
      resolveEditorSshTarget({
        entry: localEntry,
        displayUrl: null,
        locationHostname: "localhost",
        isElectron: false,
        sshServerStatus: { checked: true, running: true, port: 22 },
      }),
    ).toBeNull();
  });

  it("targets localhost for local testing after sshd detection", () => {
    expect(
      resolveEditorSshTarget({
        entry: localEntry,
        displayUrl: null,
        locationHostname: "127.0.0.1",
        isElectron: false,
        sshServerStatus: { checked: true, running: true, port: 22 },
        allowLocalTesting: true,
      }),
    ).toEqual({
      alias: "localhost",
      hostname: "localhost",
      username: null,
      port: null,
    });
  });

  it("allows an explicit SSH config alias for local testing without port 22 detection", () => {
    expect(
      resolveEditorSshTarget({
        entry: localEntry,
        displayUrl: null,
        locationHostname: "localhost",
        isElectron: false,
        sshServerStatus: { checked: true, running: false, port: 22 },
        sshAliasOverride: "local-sshd",
        allowLocalTesting: true,
      }),
    ).toEqual({
      alias: "local-sshd",
      hostname: "local-sshd",
      username: null,
      port: null,
    });
  });
});
