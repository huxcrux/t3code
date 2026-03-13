import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  searchProjectPickerResults,
  searchProjects,
  searchThreads,
  type ProjectPickerThreadSearchEntry,
} from "./projectPickerSearch";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Project, type Thread } from "../types";

function makeProject(input: { id: string; name: string; cwd: string }): Project {
  return {
    id: ProjectId.makeUnsafe(input.id),
    name: input.name,
    cwd: input.cwd,
    model: "gpt-5-codex",
    expanded: true,
    scripts: [],
  };
}

function makeThread(input: { id: string; projectId: string; title: string; createdAt?: string }): Thread {
  return {
    id: ThreadId.makeUnsafe(input.id),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe(input.projectId),
    title: input.title,
    model: "gpt-5-codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: input.createdAt ?? "2026-03-07T00:00:00.000Z",
    latestTurn: null,
    lastVisitedAt: undefined,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
  };
}

describe("searchProjects", () => {
  const projects = [
    makeProject({ id: "project-1", name: "Alpha API", cwd: "/work/alpha-api" }),
    makeProject({ id: "project-2", name: "Bravo Web", cwd: "/work/client/bravo-web" }),
    makeProject({ id: "project-3", name: "Charlie Service", cwd: "/srv/charlie" }),
  ];

  it("returns all projects in original order when the query is empty", () => {
    expect(searchProjects(projects, "")).toEqual(projects);
    expect(searchProjects(projects, "   ")).toEqual(projects);
  });

  it("matches project names before cwd matches", () => {
    const results = searchProjects(
      [
        makeProject({ id: "project-1", name: "Gamma", cwd: "/workspaces/shared" }),
        makeProject({ id: "project-2", name: "Shared Console", cwd: "/tmp/zeta" }),
      ],
      "shared",
    );

    expect(results.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-2"),
      ProjectId.makeUnsafe("project-1"),
    ]);
  });

  it("matches fuzzy project names", () => {
    expect(searchProjects(projects, "cserv").map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-3"),
    ]);
  });

  it("matches cwd values", () => {
    expect(searchProjects(projects, "client").map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-2"),
    ]);
  });

  it("keeps original order for equal scores", () => {
    const equalProjects = [
      makeProject({ id: "project-a", name: "Docs", cwd: "/tmp/docs-a" }),
      makeProject({ id: "project-b", name: "Docs", cwd: "/tmp/docs-b" }),
    ];

    expect(searchProjects(equalProjects, "docs").map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-a"),
      ProjectId.makeUnsafe("project-b"),
    ]);
  });
});

describe("searchThreads", () => {
  const alphaProject = makeProject({ id: "project-1", name: "Alpha API", cwd: "/work/alpha-api" });
  const bravoProject = makeProject({
    id: "project-2",
    name: "Bravo Web",
    cwd: "/work/client/bravo-web",
  });
  const threads: ProjectPickerThreadSearchEntry[] = [
    {
      thread: makeThread({ id: "thread-1", projectId: "project-1", title: "Fix auth redirect" }),
      project: alphaProject,
    },
    {
      thread: makeThread({ id: "thread-2", projectId: "project-2", title: "Landing page polish" }),
      project: bravoProject,
    },
  ];

  it("returns threads in original order when the query is empty", () => {
    expect(searchThreads(threads, "")).toEqual(threads);
  });

  it("matches thread titles before project metadata", () => {
    const results = searchThreads(
      [
        {
          thread: makeThread({ id: "thread-a", projectId: "project-1", title: "General follow-up" }),
          project: makeProject({ id: "project-1", name: "Shared Console", cwd: "/tmp/one" }),
        },
        {
          thread: makeThread({ id: "thread-b", projectId: "project-2", title: "Shared draft plan" }),
          project: makeProject({ id: "project-2", name: "Gamma", cwd: "/tmp/two" }),
        },
      ],
      "shared",
    );

    expect(results.map((entry) => entry.thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-b"),
      ThreadId.makeUnsafe("thread-a"),
    ]);
  });

  it("matches project metadata for thread results", () => {
    expect(searchThreads(threads, "client").map((entry) => entry.thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-2"),
    ]);
  });

  it("prefers exact thread title matches over looser thread title matches", () => {
    const results = searchThreads(
      [
        {
          thread: makeThread({ id: "thread-exact", projectId: "project-1", title: "Auth" }),
          project: alphaProject,
        },
        {
          thread: makeThread({
            id: "thread-prefix",
            projectId: "project-2",
            title: "Auth redirect cleanup",
          }),
          project: bravoProject,
        },
      ],
      "auth",
    );

    expect(results.map((entry) => entry.thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-exact"),
      ThreadId.makeUnsafe("thread-prefix"),
    ]);
  });

  it("prefers thread title matches over parent project name matches", () => {
    const results = searchThreads(
      [
        {
          thread: makeThread({ id: "thread-project", projectId: "project-1", title: "General follow-up" }),
          project: makeProject({ id: "project-1", name: "Auth Console", cwd: "/tmp/one" }),
        },
        {
          thread: makeThread({ id: "thread-title", projectId: "project-2", title: "Auth redirect cleanup" }),
          project: makeProject({ id: "project-2", name: "Gamma", cwd: "/tmp/two" }),
        },
      ],
      "auth",
    );

    expect(results.map((entry) => entry.thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-title"),
      ThreadId.makeUnsafe("thread-project"),
    ]);
  });

  it("matches thread branch names", () => {
    const results = searchThreads(
      [
        {
          thread: {
            ...makeThread({
              id: "thread-branch",
              projectId: "project-1",
              title: "General follow-up",
            }),
            branch: "feature/auth-search",
          },
          project: alphaProject,
        },
      ],
      "auth-search",
    );

    expect(results.map((entry) => entry.thread.id)).toEqual([ThreadId.makeUnsafe("thread-branch")]);
  });
});

describe("searchProjectPickerResults", () => {
  it("returns projects first, then threads", () => {
    const project = makeProject({ id: "project-1", name: "Alpha API", cwd: "/work/alpha-api" });
    const threadEntry = {
      thread: makeThread({ id: "thread-1", projectId: "project-1", title: "Fix auth redirect" }),
      project,
    };

    const results = searchProjectPickerResults({
      projects: [project],
      threads: [threadEntry],
      query: "alpha",
    });

    expect(results.projects.map((entry) => entry.id)).toEqual([ProjectId.makeUnsafe("project-1")]);
    expect(results.threads.map((entry) => entry.thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-1"),
    ]);
  });
});
