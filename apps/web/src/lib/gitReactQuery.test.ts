import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, afterEach, vi } from "vitest";
import type { NativeApi } from "@t3tools/contracts";
import {
  gitDiffQueryOptions,
  gitMutationKeys,
  gitQueryKeys,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
} from "./gitReactQuery";
import * as nativeApi from "../nativeApi";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("gitMutationKeys", () => {
  it("scopes diff keys by cwd", () => {
    expect(gitQueryKeys.diff("/repo/a")).not.toEqual(gitQueryKeys.diff("/repo/b"));
  });

  it("scopes stacked action keys by cwd", () => {
    expect(gitMutationKeys.runStackedAction("/repo/a")).not.toEqual(
      gitMutationKeys.runStackedAction("/repo/b"),
    );
  });

  it("scopes pull keys by cwd", () => {
    expect(gitMutationKeys.pull("/repo/a")).not.toEqual(gitMutationKeys.pull("/repo/b"));
  });
});

describe("git mutation options", () => {
  const queryClient = new QueryClient();

  it("attaches cwd-scoped mutation key for runStackedAction", () => {
    const options = gitRunStackedActionMutationOptions({ cwd: "/repo/a", queryClient });
    expect(options.mutationKey).toEqual(gitMutationKeys.runStackedAction("/repo/a"));
  });

  it("attaches cwd-scoped mutation key for pull", () => {
    const options = gitPullMutationOptions({ cwd: "/repo/a", queryClient });
    expect(options.mutationKey).toEqual(gitMutationKeys.pull("/repo/a"));
  });

  it("requests repo diff through the native git API", async () => {
    const diff = vi.fn().mockResolvedValue({ diff: "patch" });
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      git: { diff },
    } as unknown as NativeApi);

    const options = gitDiffQueryOptions("/repo/a");
    await queryClient.fetchQuery(options);

    expect(diff).toHaveBeenCalledWith({ cwd: "/repo/a" });
  });
});
