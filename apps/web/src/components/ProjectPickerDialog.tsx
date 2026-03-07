import { TerminalIcon } from "lucide-react";
import { type ProjectId, type ThreadId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { ProjectFavicon } from "./ProjectFavicon";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandShortcut,
} from "./ui/command";
import {
  searchProjectPickerResults,
  type ProjectPickerSearchResult,
  type ProjectPickerThreadSearchEntry,
} from "../lib/projectPickerSearch";
import {
  type TerminalStatusIndicator,
  type ThreadStatusPill,
} from "../lib/threadStatus";
import { type Project } from "../types";
import { cn } from "../lib/utils";

interface ProjectPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: readonly Project[];
  threads: readonly ProjectPickerThreadSearchEntry[];
  activeProjectId: ProjectId | null;
  activeThreadId: ThreadId | null;
  threadCountByProjectId: ReadonlyMap<ProjectId, number>;
  threadIndicatorsByThreadId: ReadonlyMap<
    ThreadId,
    {
      threadStatus: ThreadStatusPill | null;
      terminalStatus: TerminalStatusIndicator | null;
    }
  >;
  onSelectProject: (projectId: ProjectId) => Promise<void> | void;
  onSelectThread: (threadId: ThreadId) => Promise<void> | void;
  shortcutLabel?: string | null;
  focusRequestId: number;
}

export function ProjectPickerDialog(props: ProjectPickerDialogProps) {
  const [query, setQuery] = useState("");
  const [highlightedItemKey, setHighlightedItemKey] =
    useState<ProjectPickerSearchResult["key"] | null>(null);
  const isEmptyQuery = query.trim().length === 0;
  const searchResults = useMemo(
    () =>
      searchProjectPickerResults({
        projects: props.projects,
        threads: props.threads,
        query,
      }),
    [props.projects, props.threads, query],
  );
  const visibleThreads = useMemo(
    () => (isEmptyQuery ? searchResults.threads.slice(0, 12) : searchResults.threads),
    [isEmptyQuery, searchResults.threads],
  );
  const visibleItems = useMemo<ProjectPickerSearchResult[]>(
    () => [
      ...searchResults.projects.map(
        (project) =>
          ({
            type: "project",
            key: `project:${project.id}`,
            project,
          }) satisfies ProjectPickerSearchResult,
      ),
      ...visibleThreads.map(
        ({ thread, project }) =>
          ({
            type: "thread",
            key: `thread:${thread.id}`,
            thread,
            project,
          }) satisfies ProjectPickerSearchResult,
      ),
    ],
    [searchResults.projects, visibleThreads],
  );
  const itemKeys = useMemo(() => visibleItems.map((item) => item.key), [visibleItems]);

  useEffect(() => {
    if (props.open) return;
    setQuery("");
    setHighlightedItemKey(null);
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const preferredItemKey: ProjectPickerSearchResult["key"] | null =
      props.activeProjectId && itemKeys.includes(`project:${props.activeProjectId}`)
        ? (`project:${props.activeProjectId}` as const)
        : props.activeThreadId && itemKeys.includes(`thread:${props.activeThreadId}`)
          ? (`thread:${props.activeThreadId}` as const)
        : null;
    setHighlightedItemKey((current) => {
      if (isEmptyQuery && preferredItemKey) {
        return preferredItemKey;
      }
      if (current && itemKeys.includes(current)) {
        return current;
      }
      return itemKeys[0] ?? null;
    });
  }, [isEmptyQuery, itemKeys, props.activeProjectId, props.activeThreadId, props.open]);

  const handleSelect = async (item: ProjectPickerSearchResult) => {
    if (item.type === "project") {
      const projectStillExists = props.projects.some((project) => project.id === item.project.id);
      if (!projectStillExists) return;
      await props.onSelectProject(item.project.id);
    } else {
      const threadStillExists = props.threads.some((entry) => entry.thread.id === item.thread.id);
      if (!threadStillExists) return;
      await props.onSelectThread(item.thread.id);
    }
    props.onOpenChange(false);
  };

  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      <CommandDialogPopup className="mt-[18vh] translate-y-0 sm:mt-[20vh] sm:max-w-2xl sm:translate-y-0">
        <Command
          items={itemKeys}
          filteredItems={itemKeys}
          onItemHighlighted={(value) => {
            setHighlightedItemKey(
              typeof value === "string" ? (value as ProjectPickerSearchResult["key"]) : null,
            );
          }}
          open
          value={highlightedItemKey ?? undefined}
        >
          <CommandPanel>
            <CommandInput
              key={props.focusRequestId}
              placeholder="Search projects and threads..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !highlightedItemKey) return;
                const item = visibleItems.find((candidate) => candidate.key === highlightedItemKey);
                if (!item) return;
                event.preventDefault();
                event.stopPropagation();
                void handleSelect(item);
              }}
            />
            <CommandList className="max-h-[min(60vh,32rem)]">
              {searchResults.projects.length > 0 ? (
                <CommandGroup>
                  <CommandGroupLabel>Projects</CommandGroupLabel>
                  {searchResults.projects.map((project) => {
                    const threadCount = props.threadCountByProjectId.get(project.id) ?? 0;
                    const isCurrent = props.activeProjectId === project.id;
                    const itemKey = `project:${project.id}` as const;
                    return (
                      <CommandItem
                        key={itemKey}
                        value={itemKey}
                        className={cn(
                          "cursor-pointer rounded-lg px-3 py-2.5",
                          highlightedItemKey === itemKey && "bg-accent text-accent-foreground",
                        )}
                        onMouseDown={(event) => {
                          event.preventDefault();
                        }}
                        onClick={() => {
                          void handleSelect({ type: "project", key: itemKey, project });
                        }}
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                          <ProjectFavicon
                            cwd={project.cwd}
                            className="size-4"
                            fallbackClassName="size-4"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium text-foreground/95">
                                {project.name}
                              </span>
                              {isCurrent ? (
                                <span className="shrink-0 rounded-full bg-accent-foreground/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                                  Current
                                </span>
                              ) : null}
                            </div>
                            <p className="truncate text-xs text-muted-foreground/70">{project.cwd}</p>
                          </div>
                        </div>
                        <span className="shrink-0 text-[11px] text-muted-foreground/60">
                          {threadCount === 1 ? "1 thread" : `${threadCount} threads`}
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ) : null}
              {visibleThreads.length > 0 ? (
                <CommandGroup>
                  <CommandGroupLabel>Threads</CommandGroupLabel>
                  {visibleThreads.map(({ thread, project }) => {
                    const itemKey = `thread:${thread.id}` as const;
                    const isCurrent = props.activeThreadId === thread.id;
                    const preview = latestThreadPreview(thread);
                    const indicators = props.threadIndicatorsByThreadId.get(thread.id);
                    return (
                      <CommandItem
                        key={itemKey}
                        value={itemKey}
                        className={cn(
                          "cursor-pointer rounded-lg px-3 py-2.5",
                          highlightedItemKey === itemKey && "bg-accent text-accent-foreground",
                        )}
                        onMouseDown={(event) => {
                          event.preventDefault();
                        }}
                        onClick={() => {
                          void handleSelect({
                            type: "thread",
                            key: itemKey,
                            thread,
                            project,
                          });
                        }}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            {indicators?.threadStatus ? (
                              <span
                                className={`inline-flex shrink-0 items-center gap-1 text-[10px] ${indicators.threadStatus.colorClass}`}
                                title={indicators.threadStatus.label}
                              >
                                <span
                                  className={`h-1.5 w-1.5 rounded-full ${indicators.threadStatus.dotClass} ${
                                    indicators.threadStatus.pulse ? "animate-pulse" : ""
                                  }`}
                                />
                                <span>{indicators.threadStatus.label}</span>
                              </span>
                            ) : null}
                            <span className="truncate text-sm font-medium text-foreground/95">
                              {thread.title}
                            </span>
                            {isCurrent ? (
                              <span className="shrink-0 rounded-full bg-accent-foreground/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                                Current
                              </span>
                            ) : null}
                          </div>
                          <p className="truncate text-xs text-muted-foreground/70">
                            {project
                              ? [project.name, thread.branch ? `branch:${thread.branch}` : null]
                                  .filter((value): value is string => value !== null)
                                  .join(" · ")
                              : thread.branch
                                ? `branch:${thread.branch}`
                                : "Unknown project"}
                          </p>
                          {preview ? (
                            <p className="truncate pt-0.5 text-[11px] text-muted-foreground/55">
                              {preview}
                            </p>
                          ) : null}
                        </div>
                        <div className="ml-3 flex shrink-0 items-center gap-2">
                          {indicators?.terminalStatus ? (
                            <span
                              role="img"
                              aria-label={indicators.terminalStatus.label}
                              title={indicators.terminalStatus.label}
                              className={`inline-flex items-center justify-center ${indicators.terminalStatus.colorClass}`}
                            >
                              <TerminalIcon
                                className={`size-3 ${indicators.terminalStatus.pulse ? "animate-pulse" : ""}`}
                              />
                            </span>
                          ) : null}
                          <span className="text-[11px] text-muted-foreground/60">
                            {formatRelativeTime(thread.createdAt)}
                          </span>
                        </div>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ) : null}
              <CommandEmpty>
                {props.projects.length === 0 ? "No projects yet." : "No matching projects or threads"}
              </CommandEmpty>
            </CommandList>
          </CommandPanel>
          <CommandFooter>
            <span>
              {searchResults.projects.length} projects ·{" "}
              {isEmptyQuery && searchResults.threads.length > visibleThreads.length
                ? `${visibleThreads.length} of ${searchResults.threads.length} recent threads`
                : `${visibleThreads.length} threads`}
            </span>
            {props.shortcutLabel ? <CommandShortcut>{props.shortcutLabel}</CommandShortcut> : null}
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function latestThreadPreview(thread: ProjectPickerThreadSearchEntry["thread"]): string | null {
  const latestMessage = thread.messages
    .toReversed()
    .find((message) => message.text.trim().length > 0);
  if (!latestMessage) return null;

  const normalized = latestMessage.text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return null;
  if (normalized.length <= 72) return normalized;
  return `${normalized.slice(0, 69)}...`;
}
