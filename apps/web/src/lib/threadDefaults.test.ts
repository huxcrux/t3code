import { describe, expect, it } from "vitest";
import {
  resolveFreshDraftEnvMode,
  resolveFreshDraftInteractionMode,
  resolveFreshDraftRuntimeMode,
  resolveImplicitWorktreeBaseBranch,
} from "./threadDefaults";

describe("resolveFreshDraftEnvMode", () => {
  it("defaults fresh drafts to local mode", () => {
    expect(resolveFreshDraftEnvMode("local")).toBe("local");
    expect(resolveFreshDraftEnvMode(undefined)).toBe("local");
  });

  it("supports fresh drafts defaulting to worktree mode", () => {
    expect(resolveFreshDraftEnvMode("worktree")).toBe("worktree");
  });
});

describe("resolveFreshDraftRuntimeMode", () => {
  it("defaults fresh drafts to full access mode", () => {
    expect(resolveFreshDraftRuntimeMode("full-access")).toBe("full-access");
    expect(resolveFreshDraftRuntimeMode(undefined)).toBe("full-access");
  });

  it("supports fresh drafts defaulting to supervised mode", () => {
    expect(resolveFreshDraftRuntimeMode("approval-required")).toBe("approval-required");
  });
});

describe("resolveFreshDraftInteractionMode", () => {
  it("defaults fresh drafts to chat mode", () => {
    expect(resolveFreshDraftInteractionMode("default")).toBe("default");
    expect(resolveFreshDraftInteractionMode(undefined)).toBe("default");
  });

  it("supports fresh drafts defaulting to plan mode", () => {
    expect(resolveFreshDraftInteractionMode("plan")).toBe("plan");
  });
});

describe("resolveImplicitWorktreeBaseBranch", () => {
  it("uses the current branch in current mode", () => {
    expect(
      resolveImplicitWorktreeBaseBranch({
        defaultNewWorktreeBaseBranchMode: "current",
        currentBranch: "feature/current",
        defaultBranch: "main",
      }),
    ).toBe("feature/current");
  });

  it("uses the repository default branch in default mode", () => {
    expect(
      resolveImplicitWorktreeBaseBranch({
        defaultNewWorktreeBaseBranchMode: "default",
        currentBranch: "feature/current",
        defaultBranch: "main",
      }),
    ).toBe("main");
  });

  it("falls back to the current branch when no repository default branch exists", () => {
    expect(
      resolveImplicitWorktreeBaseBranch({
        defaultNewWorktreeBaseBranchMode: "default",
        currentBranch: "feature/current",
        defaultBranch: null,
      }),
    ).toBe("feature/current");
  });

  it("returns null when no candidate base branch exists", () => {
    expect(
      resolveImplicitWorktreeBaseBranch({
        defaultNewWorktreeBaseBranchMode: "default",
        currentBranch: null,
        defaultBranch: null,
      }),
    ).toBeNull();
  });
});
