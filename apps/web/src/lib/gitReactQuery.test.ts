import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  gitMutationKeys,
  gitPreparePullRequestThreadMutationOptions,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
} from "./gitReactQuery";

const runStackedActionMock = vi.fn();

vi.mock("../nativeApi", () => ({
  ensureNativeApi: () => ({
    git: {
      runStackedAction: runStackedActionMock,
    },
  }),
}));

describe("gitMutationKeys", () => {
  it("scopes stacked action keys by cwd", () => {
    expect(gitMutationKeys.runStackedAction("/repo/a")).not.toEqual(
      gitMutationKeys.runStackedAction("/repo/b"),
    );
  });

  it("scopes pull keys by cwd", () => {
    expect(gitMutationKeys.pull("/repo/a")).not.toEqual(gitMutationKeys.pull("/repo/b"));
  });

  it("scopes pull request thread preparation keys by cwd", () => {
    expect(gitMutationKeys.preparePullRequestThread("/repo/a")).not.toEqual(
      gitMutationKeys.preparePullRequestThread("/repo/b"),
    );
  });
});

describe("git mutation options", () => {
  const queryClient = new QueryClient();

  beforeEach(() => {
    runStackedActionMock.mockReset();
    runStackedActionMock.mockResolvedValue({ ok: true });
  });

  it("attaches cwd-scoped mutation key for runStackedAction", () => {
    const options = gitRunStackedActionMutationOptions({ cwd: "/repo/a", queryClient });
    expect(options.mutationKey).toEqual(gitMutationKeys.runStackedAction("/repo/a"));
  });

  it("attaches cwd-scoped mutation key for pull", () => {
    const options = gitPullMutationOptions({ cwd: "/repo/a", queryClient });
    expect(options.mutationKey).toEqual(gitMutationKeys.pull("/repo/a"));
  });

  it("attaches cwd-scoped mutation key for preparePullRequestThread", () => {
    const options = gitPreparePullRequestThreadMutationOptions({
      cwd: "/repo/a",
      queryClient,
    });
    expect(options.mutationKey).toEqual(gitMutationKeys.preparePullRequestThread("/repo/a"));
  });

  it("passes provider and model to runStackedAction requests", async () => {
    const options = gitRunStackedActionMutationOptions({
      cwd: "/repo/a",
      queryClient,
      provider: "claudeAgent",
      model: "claude-haiku-4-5",
    });

    await options.mutationFn?.(
      {
        action: "commit",
      },
      {} as never,
    );

    expect(runStackedActionMock).toHaveBeenCalledWith({
      cwd: "/repo/a",
      action: "commit",
      textGenerationProvider: "claudeAgent",
      textGenerationModel: "claude-haiku-4-5",
    });
  });
});
