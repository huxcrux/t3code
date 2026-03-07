import { type Project, type Thread } from "../types";

type SwitcherScore = {
  score: number;
  fieldWeight: number;
};

const PROJECT_NAME_FIELD_WEIGHT = 10_000;
const THREAD_TITLE_FIELD_WEIGHT = 20_000;
const THREAD_PROJECT_NAME_FIELD_WEIGHT = 2_000;
const THREAD_BRANCH_FIELD_WEIGHT = 1_000;

export interface ProjectPickerThreadSearchEntry {
  thread: Thread;
  project: Project | null;
}

export type ProjectPickerSearchResult =
  | {
      type: "project";
      key: `project:${string}`;
      project: Project;
    }
  | {
      type: "thread";
      key: `thread:${string}`;
      thread: Thread;
      project: Project | null;
    };

function scoreField(target: string, query: string): number | null {
  if (query.length === 0) return 0;
  if (target.length === 0) return null;

  if (target === query) {
    return 1_200;
  }

  if (target.startsWith(query)) {
    return 1_000 - (target.length - query.length);
  }

  const wordPrefixIndex = target.search(new RegExp(`(?:^|[\\\\/\\s._-])${escapeRegExp(query)}`));
  if (wordPrefixIndex >= 0) {
    return 900 - wordPrefixIndex;
  }

  const contiguousIndex = target.indexOf(query);
  if (contiguousIndex >= 0) {
    return 800 - contiguousIndex;
  }

  let queryIndex = 0;
  let startIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;

  for (let index = 0; index < target.length && queryIndex < query.length; index += 1) {
    if (target[index] !== query[queryIndex]) continue;
    if (startIndex === -1) {
      startIndex = index;
    } else {
      gapPenalty += Math.max(0, index - previousMatchIndex - 1);
    }
    previousMatchIndex = index;
    queryIndex += 1;
  }

  if (queryIndex !== query.length || startIndex === -1) {
    return null;
  }

  return 500 - startIndex * 3 - gapPenalty * 8 - (target.length - query.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bestScore(
  candidates: ReadonlyArray<{ value: string; fieldWeight: number }>,
  query: string,
): SwitcherScore | null {
  let best: SwitcherScore | null = null;
  for (const candidate of candidates) {
    const candidateScore = scoreField(candidate.value, query);
    if (candidateScore === null) continue;
    const next = {
      score: candidateScore + candidate.fieldWeight,
      fieldWeight: candidate.fieldWeight,
    };
    if (
      best === null ||
      next.score > best.score ||
      (next.score === best.score && next.fieldWeight > best.fieldWeight)
    ) {
      best = next;
    }
  }
  return best;
}

export function searchProjects(projects: readonly Project[], rawQuery: string): Project[] {
  const query = rawQuery.trim().toLowerCase();
  if (query.length === 0) {
    return [...projects];
  }

  return projects
    .map((project, index) => {
      const score = bestScore(
        [
          { value: project.name.toLowerCase(), fieldWeight: PROJECT_NAME_FIELD_WEIGHT },
          { value: project.cwd.toLowerCase(), fieldWeight: 0 },
        ],
        query,
      );
      if (score === null) return null;
      return { index, project, score: score.score };
    })
    .filter((entry): entry is { index: number; project: Project; score: number } => entry !== null)
    .toSorted((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.project);
}

export function searchThreads(
  entries: readonly ProjectPickerThreadSearchEntry[],
  rawQuery: string,
): ProjectPickerThreadSearchEntry[] {
  const query = rawQuery.trim().toLowerCase();
  if (query.length === 0) {
    return [...entries];
  }

  return entries
    .map((entry, index) => {
      const score = bestScore(
        [
          { value: entry.thread.title.toLowerCase(), fieldWeight: THREAD_TITLE_FIELD_WEIGHT },
          {
            value: entry.thread.branch?.toLowerCase() ?? "",
            fieldWeight: THREAD_BRANCH_FIELD_WEIGHT,
          },
          {
            value: entry.project?.name.toLowerCase() ?? "",
            fieldWeight: THREAD_PROJECT_NAME_FIELD_WEIGHT,
          },
          { value: entry.project?.cwd.toLowerCase() ?? "", fieldWeight: 0 },
        ],
        query,
      );
      if (score === null) return null;
      return { entry, index, score: score.score };
    })
    .filter(
      (entry): entry is { entry: ProjectPickerThreadSearchEntry; index: number; score: number } =>
        entry !== null,
    )
    .toSorted((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.entry);
}

export function searchProjectPickerResults(input: {
  projects: readonly Project[];
  threads: readonly ProjectPickerThreadSearchEntry[];
  query: string;
}): {
  projects: Project[];
  threads: ProjectPickerThreadSearchEntry[];
  items: ProjectPickerSearchResult[];
} {
  const projects = searchProjects(input.projects, input.query);
  const threads = searchThreads(input.threads, input.query);
  return {
    projects,
    threads,
    items: [
      ...projects.map(
        (project) =>
          ({
            type: "project",
            key: `project:${project.id}`,
            project,
          }) satisfies ProjectPickerSearchResult,
      ),
      ...threads.map(
        (entry) =>
          ({
            type: "thread",
            key: `thread:${entry.thread.id}`,
            thread: entry.thread,
            project: entry.project,
          }) satisfies ProjectPickerSearchResult,
      ),
    ],
  };
}
