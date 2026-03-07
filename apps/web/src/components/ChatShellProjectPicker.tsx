import { ThreadId, type ProjectId, type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useComposerDraftStore } from "../composerDraftStore";
import { useProjectNavigation } from "../hooks/useProjectNavigation";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { getTerminalStatusIndicator, getThreadStatusPill } from "../lib/threadStatus";
import { useStore } from "../store";
import { derivePendingApprovals } from "../session-logic";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { ProjectPickerDialog } from "./ProjectPickerDialog";
import { type ProjectPickerThreadSearchEntry } from "../lib/projectPickerSearch";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

function isTerminalFocused(): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;
  if (activeElement.classList.contains("xterm-helper-textarea")) return true;
  return activeElement.closest(".thread-terminal-drawer .xterm") !== null;
}

export function ChatShellProjectPicker() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const navigate = useNavigate();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const activeDraftThread = useComposerDraftStore((store) =>
    routeThreadId ? store.draftThreadsByThreadId[routeThreadId] ?? null : null,
  );
  const { openProject } = useProjectNavigation();
  const { data: keybindings = EMPTY_KEYBINDINGS } = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.keybindings,
  });
  const [open, setOpen] = useState(false);
  const [focusRequestId, setFocusRequestId] = useState(0);

  const activeProjectId = useMemo<ProjectId | null>(() => {
    const activeThread = routeThreadId ? threads.find((thread) => thread.id === routeThreadId) : null;
    return activeThread?.projectId ?? activeDraftThread?.projectId ?? null;
  }, [activeDraftThread?.projectId, routeThreadId, threads]);

  const threadCountByProjectId = useMemo(() => {
    const counts = new Map<ProjectId, number>();
    for (const project of projects) {
      counts.set(project.id, 0);
    }
    for (const thread of threads) {
      counts.set(thread.projectId, (counts.get(thread.projectId) ?? 0) + 1);
    }
    return counts;
  }, [projects, threads]);
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project] as const)),
    [projects],
  );
  const threadEntries = useMemo<ProjectPickerThreadSearchEntry[]>(
    () =>
      threads
        .toSorted((left, right) => {
          const byDate = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
          if (byDate !== 0) return byDate;
          return right.id.localeCompare(left.id);
        })
        .map((thread) => ({
          thread,
          project: projectById.get(thread.projectId) ?? null,
        })),
    [projectById, threads],
  );
  const threadIndicatorsByThreadId = useMemo(() => {
    const indicators = new Map<
      ThreadId,
      {
        threadStatus: ReturnType<typeof getThreadStatusPill>;
        terminalStatus: ReturnType<typeof getTerminalStatusIndicator>;
      }
    >();
    for (const thread of threads) {
      indicators.set(thread.id, {
        threadStatus: getThreadStatusPill(thread, derivePendingApprovals(thread.activities).length > 0),
        terminalStatus: getTerminalStatusIndicator(
          selectThreadTerminalState(terminalStateByThreadId, thread.id).runningTerminalIds,
        ),
      });
    }
    return indicators;
  }, [terminalStateByThreadId, threads]);

  const openPicker = useCallback(() => {
    setOpen(true);
    setFocusRequestId((current) => current + 1);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: false,
        },
      });
      if (command !== "chat.projectPicker") return;
      event.preventDefault();
      event.stopPropagation();
      openPicker();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [keybindings, openPicker]);

  return (
    <ProjectPickerDialog
      open={open}
      onOpenChange={setOpen}
      projects={projects}
      threads={threadEntries}
      activeProjectId={activeProjectId}
      activeThreadId={routeThreadId}
      threadCountByProjectId={threadCountByProjectId}
      threadIndicatorsByThreadId={threadIndicatorsByThreadId}
      onSelectProject={openProject}
      onSelectThread={async (threadId) => {
        await navigate({
          to: "/$threadId",
          params: { threadId },
        });
      }}
      shortcutLabel={shortcutLabelForCommand(keybindings, "chat.projectPicker")}
      focusRequestId={focusRequestId}
    />
  );
}
