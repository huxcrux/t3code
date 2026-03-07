import { useCallback } from "react";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useComposerDraftStore, type DraftThreadEnvMode } from "../composerDraftStore";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../types";
import { newThreadId } from "../lib/utils";

export interface ProjectNavigationContext {
  routeThreadId: ThreadId | null;
  getDraftThreadByProjectId: ReturnType<typeof useComposerDraftStore.getState>["getDraftThreadByProjectId"];
  getDraftThread: ReturnType<typeof useComposerDraftStore.getState>["getDraftThread"];
  setProjectDraftThreadId: ReturnType<typeof useComposerDraftStore.getState>["setProjectDraftThreadId"];
  setDraftThreadContext: ReturnType<typeof useComposerDraftStore.getState>["setDraftThreadContext"];
  clearProjectDraftThreadId: ReturnType<typeof useComposerDraftStore.getState>["clearProjectDraftThreadId"];
  navigateToThread: (threadId: ThreadId) => Promise<void>;
}

export function createProjectNavigationActions(context: ProjectNavigationContext) {
  const createOrFocusDraftThread = async (
    projectId: ProjectId,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
    },
  ): Promise<void> => {
    const hasBranchOption = options?.branch !== undefined;
    const hasWorktreePathOption = options?.worktreePath !== undefined;
    const hasEnvModeOption = options?.envMode !== undefined;
    const storedDraftThread = context.getDraftThreadByProjectId(projectId);
    if (storedDraftThread) {
      if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
        context.setDraftThreadContext(storedDraftThread.threadId, {
          ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
          ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
          ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
        });
      }
      context.setProjectDraftThreadId(projectId, storedDraftThread.threadId);
      if (context.routeThreadId !== storedDraftThread.threadId) {
        await context.navigateToThread(storedDraftThread.threadId);
      }
      return;
    }

    context.clearProjectDraftThreadId(projectId);

    const activeDraftThread = context.routeThreadId
      ? context.getDraftThread(context.routeThreadId)
      : null;
    if (activeDraftThread && context.routeThreadId && activeDraftThread.projectId === projectId) {
      if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
        context.setDraftThreadContext(context.routeThreadId, {
          ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
          ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
          ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
        });
      }
      context.setProjectDraftThreadId(projectId, context.routeThreadId);
      return;
    }

    const threadId = newThreadId();
    context.setProjectDraftThreadId(projectId, threadId, {
      createdAt: new Date().toISOString(),
      branch: options?.branch ?? null,
      worktreePath: options?.worktreePath ?? null,
      envMode: options?.envMode ?? "local",
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_INTERACTION_MODE,
    });
    await context.navigateToThread(threadId);
  };

  const openProject = async (projectId: ProjectId): Promise<void> => {
    await createOrFocusDraftThread(projectId);
  };

  return {
    createOrFocusDraftThread,
    openProject,
  };
}

export function useProjectNavigation() {
  const navigate = useNavigate();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const getDraftThreadByProjectId = useComposerDraftStore((store) => store.getDraftThreadByProjectId);
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const setProjectDraftThreadId = useComposerDraftStore((store) => store.setProjectDraftThreadId);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const clearProjectDraftThreadId = useComposerDraftStore((store) => store.clearProjectDraftThreadId);

  const navigateToThread = useCallback(
    async (threadId: ThreadId) => {
      await navigate({
        to: "/$threadId",
        params: { threadId },
      });
    },
    [navigate],
  );

  const createOrFocusDraftThread = useCallback(
    (
      projectId: ProjectId,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
      },
    ) =>
      createProjectNavigationActions({
        routeThreadId,
        getDraftThreadByProjectId,
        getDraftThread,
        setProjectDraftThreadId,
        setDraftThreadContext,
        clearProjectDraftThreadId,
        navigateToThread,
      }).createOrFocusDraftThread(projectId, options),
    [
      clearProjectDraftThreadId,
      getDraftThread,
      getDraftThreadByProjectId,
      navigateToThread,
      routeThreadId,
      setDraftThreadContext,
      setProjectDraftThreadId,
    ],
  );

  const openProject = useCallback(
    (projectId: ProjectId) =>
      createProjectNavigationActions({
        routeThreadId,
        getDraftThreadByProjectId,
        getDraftThread,
        setProjectDraftThreadId,
        setDraftThreadContext,
        clearProjectDraftThreadId,
        navigateToThread,
      }).openProject(projectId),
    [
      clearProjectDraftThreadId,
      getDraftThread,
      getDraftThreadByProjectId,
      navigateToThread,
      routeThreadId,
      setDraftThreadContext,
      setProjectDraftThreadId,
    ],
  );

  return { createOrFocusDraftThread, openProject };
}
