import { assert, describe, it } from "@effect/vitest";
import type { PermissionRequest } from "@github/copilot-sdk";
import { ProviderInstanceId } from "@t3tools/contracts";

import { permissionAutoApproved, permissionRequestKind } from "./approvals.ts";
import { copilotSessionModelConfig } from "./runtime.ts";
import { stripCopilotShellControlLines } from "./toolPresentation.ts";

const shell = { kind: "shell", fullCommandText: "ls" } as unknown as PermissionRequest;
const write = { kind: "write", fileName: "a.ts" } as unknown as PermissionRequest;
const selection = (options: ReadonlyArray<{ id: string; value: string }> = []) => ({
  instanceId: ProviderInstanceId.make("copilot"),
  model: "gpt-5",
  options: [...options],
});

describe("Copilot approvals", () => {
  it("auto-approves according to the runtime mode", () => {
    assert.isTrue(permissionAutoApproved("full-access", shell, undefined));
    assert.isFalse(permissionAutoApproved("approval-required", shell, undefined));
    assert.isTrue(permissionAutoApproved("auto-accept-edits", write, undefined));
    assert.isFalse(permissionAutoApproved("auto-accept-edits", shell, undefined));
  });

  it("always asks when Copilot requires managed approval", () => {
    const managed = { ...shell, managedApprovalRequired: true } as PermissionRequest;
    assert.isFalse(permissionAutoApproved("full-access", managed, undefined));
  });

  it("maps permission kinds to T3 request kinds", () => {
    assert.strictEqual(permissionRequestKind(shell), "command");
    assert.strictEqual(permissionRequestKind(write), "file-change");
  });
});

describe("copilotSessionModelConfig", () => {
  it("passes supported session efforts directly", () => {
    const { config, needsSwitch } = copilotSessionModelConfig(
      selection([{ id: "reasoningEffort", value: "high" }]),
    );
    assert.deepStrictEqual(config, { model: "gpt-5", reasoningEffort: "high" });
    assert.isFalse(needsSwitch);
  });

  it("switches models for efforts the session config cannot carry", () => {
    const { config, needsSwitch } = copilotSessionModelConfig(
      selection([{ id: "reasoningEffort", value: "none" }]),
    );
    assert.deepStrictEqual(config, { model: "gpt-5" });
    assert.isTrue(needsSwitch);
  });
});

describe("stripCopilotShellControlLines", () => {
  it("removes Copilot's shell bookkeeping lines", () => {
    assert.strictEqual(
      stripCopilotShellControlLines("hello\r\n<exited with exit code 0>\n"),
      "hello",
    );
  });
});
