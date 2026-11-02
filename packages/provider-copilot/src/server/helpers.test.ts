import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ModelInfo, PermissionRequest } from "@github/copilot-sdk";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { CopilotSettings } from "../settings.ts";

import { permissionAutoApproved, permissionRequestKind } from "./approvals.ts";
import {
  authFromCopilotStatus,
  buildCopilotClientOptions,
  capabilitiesFromCopilotModel,
  copilotSessionModelConfig,
  isolateCopilotCredentials,
  modelsFromCopilotSdk,
  resolveCopilotModelSelection,
} from "./runtime.ts";
import { stripCopilotShellControlLines } from "./toolPresentation.ts";

const decodeSettings = Schema.decodeEffect(CopilotSettings);
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

describe("Copilot model defaults", () => {
  const catalogModel = (
    efforts: ReadonlyArray<string> | undefined,
    reported?: string,
    longContext = true,
  ) =>
    ({
      id: "gpt-5",
      capabilities: { limits: { max_context_window_tokens: 1_000_000 } },
      ...(efforts ? { supportedReasoningEfforts: [...efforts] } : {}),
      ...(reported ? { defaultReasoningEffort: reported } : {}),
      billing: {
        tokenPrices: {
          maxPromptTokens: 200_000,
          ...(longContext ? { longContext: { maxPromptTokens: 936_000 } } : {}),
        },
      },
    }) as unknown as ModelInfo;
  const defaults = (model: ModelInfo) =>
    Object.fromEntries(
      (capabilitiesFromCopilotModel(model).optionDescriptors ?? []).map((descriptor) => [
        descriptor.id,
        descriptor.currentValue,
      ]),
    );

  it("selects Copilot's default effort, else Medium or the nearest supported level", () => {
    const cases = [
      [["low", "medium", "high"], "high", "high"],
      [["low", "medium", "high"], undefined, "medium"],
      [["high", "xhigh"], undefined, "high"],
      [["none", "low"], undefined, "low"],
    ] as const;
    for (const [efforts, reported, expected] of cases) {
      assert.strictEqual(defaults(catalogModel(efforts, reported)).reasoningEffort, expected);
    }
    assert.notProperty(defaults(catalogModel(undefined)), "reasoningEffort");
  });

  it("shows the context window even without a long-context tier", () => {
    const withTier = capabilitiesFromCopilotModel(catalogModel(["low"]));
    const withoutTier = capabilitiesFromCopilotModel(catalogModel(["low"], undefined, false));
    const labels = (caps: typeof withTier) => {
      const descriptor = caps.optionDescriptors?.find(({ id }) => id === "contextTier");
      return descriptor?.type === "select" ? descriptor.options.map(({ label }) => label) : [];
    };
    assert.deepStrictEqual(labels(withTier), ["200K", "1M"]);
    assert.deepStrictEqual(labels(withoutTier), ["200K"]);
  });

  it("fills unselected options from the catalog and keeps explicit picks", () => {
    const models = modelsFromCopilotSdk([catalogModel(["low", "medium", "high"])], []);
    assert.deepStrictEqual(resolveCopilotModelSelection(selection(), models).options, [
      { id: "reasoningEffort", value: "medium" },
      { id: "contextTier", value: "default" },
    ]);
    assert.deepStrictEqual(
      resolveCopilotModelSelection(selection([{ id: "reasoningEffort", value: "high" }]), models)
        .options,
      [
        { id: "reasoningEffort", value: "high" },
        { id: "contextTier", value: "default" },
      ],
    );
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

describe("authFromCopilotStatus", () => {
  const status = {
    isAuthenticated: true,
    authType: "user",
    login: "octocat",
    host: "https://github.com",
  } as const;

  it("labels the subscription plan and reports the login as the account identity", () => {
    const cases = [
      [
        { copilot_plan: "individual", access_type_sku: "monthly_subscriber_quota" },
        "Copilot Pro Subscription",
      ],
      [
        { copilot_plan: "individual_pro", access_type_sku: "plus_monthly_subscriber_quota" },
        "Copilot Pro+ Subscription",
      ],
      [
        { copilot_plan: "individual", access_type_sku: "free_limited_copilot" },
        "Copilot Free Subscription",
      ],
      [
        { copilot_plan: "business", access_type_sku: "copilot_for_business_seat_quota" },
        "Copilot Business Subscription",
      ],
      [undefined, undefined],
    ] as const;
    for (const [user, label] of cases) {
      assert.deepStrictEqual(authFromCopilotStatus(status, user).auth, {
        status: "authenticated",
        type: "user",
        ...(label ? { label } : {}),
        email: "@octocat",
      });
    }
  });

  it("keeps non-github.com hosts visible", () => {
    const auth = authFromCopilotStatus(
      { ...status, authType: "gh-cli", host: "https://ghe.example.com" },
      undefined,
    ).auth;
    assert.strictEqual(auth.label, "GitHub CLI · ghe.example.com");
  });
});

describe("Copilot credentials", () => {
  const host = { PATH: "/usr/bin:/bin", GH_TOKEN: "host-gh", GITHUB_TOKEN: "host-github" };

  it("keeps the host login only for instances without their own credentials", () => {
    assert.deepStrictEqual(isolateCopilotCredentials([], host), host);
    assert.deepStrictEqual(
      isolateCopilotCredentials([{ name: "COPILOT_GITHUB_TOKEN", value: " " }], host),
      host,
    );
    assert.deepStrictEqual(
      isolateCopilotCredentials([{ name: "COPILOT_GITHUB_TOKEN", value: "instance" }], {
        ...host,
        COPILOT_GITHUB_TOKEN: "instance",
      }),
      { PATH: "/usr/bin:/bin", COPILOT_GITHUB_TOKEN: "instance" },
    );
    assert.deepStrictEqual(
      isolateCopilotCredentials([{ name: "COPILOT_HOME", value: "/a" }], {
        ...host,
        COPILOT_HOME: "/a",
      }),
      { PATH: "/usr/bin:/bin", COPILOT_HOME: "/a" },
    );
  });

  it.effect("disables the saved-login fallback when a Copilot token is set", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const binaryPath = `${yield* fileSystem.makeTempDirectoryScoped()}/copilot`;
      yield* fileSystem.writeFileString(binaryPath, "#!/bin/sh\n");
      yield* fileSystem.chmod(binaryPath, 0o755);
      const settings = yield* decodeSettings({ binaryPath });
      const options = (environment: NodeJS.ProcessEnv) =>
        buildCopilotClientOptions({ settings, environment });
      assert.isTrue((yield* options(host)).useLoggedInUser);
      assert.isFalse((yield* options({ ...host, COPILOT_GITHUB_TOKEN: "t" })).useLoggedInUser);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
