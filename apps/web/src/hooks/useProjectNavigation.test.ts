import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";
import { createProjectNavigationActions } from "./useProjectNavigation";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../types";

describe("createProjectNavigationActions", () => {
  it("opens a draft thread for a project even when persisted threads already exist", async () => {
    const navigateToThread = vi.fn(async () => undefined);
    const setProjectDraftThreadId = vi.fn();
    const actions = createProjectNavigationActions({
      routeThreadId: null,
      getDraftThreadByProjectId: () => null,
      getDraftThread: () => null,
      setProjectDraftThreadId,
      setDraftThreadContext: vi.fn(),
      clearProjectDraftThreadId: vi.fn(),
      navigateToThread,
    });

    await actions.openProject(ProjectId.makeUnsafe("project-1"));

    expect(setProjectDraftThreadId).toHaveBeenCalledOnce();
    expect(setProjectDraftThreadId.mock.calls[0]?.[0]).toEqual(ProjectId.makeUnsafe("project-1"));
    expect(navigateToThread).toHaveBeenCalledOnce();
  });

  it("reuses an existing draft thread when a project has no persisted threads", async () => {
    const navigateToThread = vi.fn(async () => undefined);
    const setProjectDraftThreadId = vi.fn();
    const actions = createProjectNavigationActions({
      routeThreadId: null,
      getDraftThreadByProjectId: () => ({
        threadId: ThreadId.makeUnsafe("draft-thread"),
        projectId: ProjectId.makeUnsafe("project-1"),
        createdAt: "2026-03-02T00:00:00.000Z",
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        envMode: "local",
      }),
      getDraftThread: () => null,
      setProjectDraftThreadId,
      setDraftThreadContext: vi.fn(),
      clearProjectDraftThreadId: vi.fn(),
      navigateToThread,
    });

    await actions.openProject(ProjectId.makeUnsafe("project-1"));

    expect(setProjectDraftThreadId).toHaveBeenCalledWith(
      ProjectId.makeUnsafe("project-1"),
      ThreadId.makeUnsafe("draft-thread"),
    );
    expect(navigateToThread).toHaveBeenCalledWith(ThreadId.makeUnsafe("draft-thread"));
  });

  it("reuses the active draft thread when it already belongs to the selected project", async () => {
    const setProjectDraftThreadId = vi.fn();
    const actions = createProjectNavigationActions({
      routeThreadId: ThreadId.makeUnsafe("active-draft"),
      getDraftThreadByProjectId: () => null,
      getDraftThread: () => ({
        projectId: ProjectId.makeUnsafe("project-1"),
        createdAt: "2026-03-02T00:00:00.000Z",
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        envMode: "local",
      }),
      setProjectDraftThreadId,
      setDraftThreadContext: vi.fn(),
      clearProjectDraftThreadId: vi.fn(),
      navigateToThread: vi.fn(async () => undefined),
    });

    await actions.openProject(ProjectId.makeUnsafe("project-1"));

    expect(setProjectDraftThreadId).toHaveBeenCalledWith(
      ProjectId.makeUnsafe("project-1"),
      ThreadId.makeUnsafe("active-draft"),
    );
  });

  it("creates a new draft thread when a project has no thread or draft", async () => {
    const navigateToThread = vi.fn(async () => undefined);
    const setProjectDraftThreadId = vi.fn();
    const actions = createProjectNavigationActions({
      routeThreadId: null,
      getDraftThreadByProjectId: () => null,
      getDraftThread: () => null,
      setProjectDraftThreadId,
      setDraftThreadContext: vi.fn(),
      clearProjectDraftThreadId: vi.fn(),
      navigateToThread,
    });

    await actions.openProject(ProjectId.makeUnsafe("project-1"));

    expect(setProjectDraftThreadId).toHaveBeenCalledOnce();
    expect(setProjectDraftThreadId.mock.calls[0]?.[0]).toEqual(ProjectId.makeUnsafe("project-1"));
    expect(navigateToThread).toHaveBeenCalledOnce();
  });
});
