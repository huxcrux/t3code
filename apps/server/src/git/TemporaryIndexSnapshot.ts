import { randomUUID } from "node:crypto";

import { Effect, FileSystem, Path, PlatformError } from "effect";

import { GitCommandError } from "./Errors.ts";
import type { GitServiceShape } from "./Services/GitService.ts";

export const EMPTY_GIT_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

interface WithTemporarySnapshotTreeInput {
  readonly operation: string;
  readonly cwd: string;
  readonly gitExecute: GitServiceShape["execute"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly baseCommitOid?: string | null;
}

export function withTemporarySnapshotTree<A, E>(
  input: WithTemporarySnapshotTreeInput,
  use: (treeOid: string) => Effect.Effect<A, E, never>,
): Effect.Effect<A, E | GitCommandError | PlatformError.PlatformError, never> {
  return Effect.acquireUseRelease(
    input.fileSystem.makeTempDirectory({ prefix: "t3-git-snapshot-" }),
    (tempDir) =>
      Effect.gen(function* () {
        const tempIndexPath = input.path.join(tempDir, `index-${randomUUID()}`);
        const snapshotEnv: NodeJS.ProcessEnv = {
          ...process.env,
          GIT_INDEX_FILE: tempIndexPath,
        };

        if (input.baseCommitOid) {
          yield* input.gitExecute({
            operation: input.operation,
            cwd: input.cwd,
            args: ["read-tree", input.baseCommitOid],
            env: snapshotEnv,
          });
        }

        yield* input.gitExecute({
          operation: input.operation,
          cwd: input.cwd,
          args: ["add", "-A", "--", "."],
          env: snapshotEnv,
        });

        const writeTreeResult = yield* input.gitExecute({
          operation: input.operation,
          cwd: input.cwd,
          args: ["write-tree"],
          env: snapshotEnv,
        });
        const treeOid = writeTreeResult.stdout.trim();
        if (treeOid.length === 0) {
          return yield* new GitCommandError({
            operation: input.operation,
            command: "git write-tree",
            cwd: input.cwd,
            detail: "git write-tree returned an empty tree oid.",
          });
        }

        return yield* use(treeOid);
      }),
    (tempDir) => input.fileSystem.remove(tempDir, { recursive: true }),
  );
}
