export const DEFAULT_NEW_THREAD_ENV_MODE_VALUES = ["local", "worktree"] as const;
export type DefaultNewThreadEnvMode = (typeof DEFAULT_NEW_THREAD_ENV_MODE_VALUES)[number];

export const DEFAULT_NEW_WORKTREE_BASE_BRANCH_MODE_VALUES = ["current", "default"] as const;
export type DefaultNewWorktreeBaseBranchMode =
  (typeof DEFAULT_NEW_WORKTREE_BASE_BRANCH_MODE_VALUES)[number];

export const NEW_THREAD_ENV_MODE_OPTIONS = [
  {
    value: "local",
    label: "Local",
    description: "Start standard new threads in the main project worktree.",
  },
  {
    value: "worktree",
    label: "New worktree",
    description: "Start standard new threads in New worktree mode.",
  },
] as const satisfies ReadonlyArray<{
  value: DefaultNewThreadEnvMode;
  label: string;
  description: string;
}>;

export const NEW_WORKTREE_BASE_BRANCH_MODE_OPTIONS = [
  {
    value: "current",
    label: "Current branch",
    description: "Seed fresh new-worktree drafts from the currently checked-out branch.",
  },
  {
    value: "default",
    label: "Repository default branch",
    description: "Prefer the repository default branch, then fall back to the current branch.",
  },
] as const satisfies ReadonlyArray<{
  value: DefaultNewWorktreeBaseBranchMode;
  label: string;
  description: string;
}>;

export function resolveFreshDraftEnvMode(
  defaultNewThreadEnvMode: DefaultNewThreadEnvMode | null | undefined,
): "local" | "worktree" {
  return defaultNewThreadEnvMode === "worktree" ? "worktree" : "local";
}

export function resolveImplicitWorktreeBaseBranch(input: {
  defaultNewWorktreeBaseBranchMode: DefaultNewWorktreeBaseBranchMode | null | undefined;
  currentBranch: string | null;
  defaultBranch: string | null;
}): string | null {
  const { defaultNewWorktreeBaseBranchMode, currentBranch, defaultBranch } = input;
  if (defaultNewWorktreeBaseBranchMode === "default") {
    return defaultBranch ?? currentBranch ?? null;
  }
  return currentBranch ?? null;
}
