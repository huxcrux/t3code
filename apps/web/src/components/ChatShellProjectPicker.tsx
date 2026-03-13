import { ThreadId, type ProjectId, type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { isTerminalFocused } from "../lib/terminalFocus";
import { useStore } from "../store";
import { derivePendingApprovals, derivePendingUserInputs } from "../session-logic";
import { ProjectPickerDialog } from "./ProjectPickerDialog";
import { type ProjectPickerThreadSearchEntry } from "../lib/projectPickerSearch";
import { resolveThreadStatusPill } from "./Sidebar.logic";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

export function ChatShellProjectPicker() {
  const threads = useStore((store) => store.threads);
  const navigate = useNavigate();
  const { activeDraftThread, activeThread, handleNewThread, projects, routeThreadId } =
    useHandleNewThread();
  const { data: keybindings = EMPTY_KEYBINDINGS } = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.keybindings,
  });
  const [open, setOpen] = useState(false);
  const [focusRequestId, setFocusRequestId] = useState(0);
  const activeProjectId: ProjectId | null =
    activeThread?.projectId ?? activeDraftThread?.projectId ?? null;

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
        threadStatus: ReturnType<typeof resolveThreadStatusPill>;
      }
    >();
    for (const thread of threads) {
      indicators.set(thread.id, {
        threadStatus: resolveThreadStatusPill({
          thread,
          hasPendingApprovals: derivePendingApprovals(thread.activities).length > 0,
          hasPendingUserInput: derivePendingUserInputs(thread.activities).length > 0,
        }),
      });
    }
    return indicators;
  }, [threads]);

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
      onSelectProject={handleNewThread}
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
