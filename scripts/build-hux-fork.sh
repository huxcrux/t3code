#!/usr/bin/env bash
# build-hux-fork.sh
# Resets hux-fork to latest origin/main, cherry-picks our feature commits,
# squashes into one commit, and builds the macOS DMG.
#
# Run from any worktree of this repo:
#   bash scripts/build-hux-fork.sh

set -euo pipefail

COMMITS=(
  "70292cb0"  # feat: project picker fuzzy window
  "640daa04"  # feat: 24-hour timestamp toggle
  "7d687876"  # feat: diff panel git diff
)

COMMIT_MSG="cherry-pick: fuzzy picker, 24hr timestamp, diff panel git diff"

# Find the hux-fork worktree path
HUX_WORKTREE="$(git worktree list --porcelain | awk '/^worktree/{wt=$2} /^branch refs\/heads\/hux-fork/{print wt}' | head -1)"

if [ -z "$HUX_WORKTREE" ]; then
  echo "ERROR: No worktree with branch 'hux-fork' found."
  echo "Create one with: git worktree add <path> hux-fork"
  exit 1
fi

echo "==> Using hux-fork worktree: $HUX_WORKTREE"
cd "$HUX_WORKTREE"

echo "==> Cleaning up any in-progress git state..."
git cherry-pick --abort 2>/dev/null || true
git merge --abort 2>/dev/null || true

echo "==> Fetching origin..."
git fetch origin

echo "==> Resetting hux-fork to origin/main..."
git reset --hard origin/main

echo "==> Cherry-picking ${#COMMITS[@]} commits (no-commit)..."
if ! git cherry-pick --no-commit "${COMMITS[@]}"; then
  echo "==> Conflicts detected — applying known resolutions..."

  UNRESOLVED="$(git diff --name-only --diff-filter=U 2>/dev/null || true)"

  for FILE in $UNRESOLVED; do
    echo "    Resolving: $FILE"
    case "$FILE" in
      apps/web/src/components/DiffPanel.tsx)
        # Conflict: HEAD has nothing; 7d687876 adds formatTurnChipTimestamp
        # and resolveDiffErrorMessage. Always take the incoming (7d687876) side.
        python3 - "$FILE" <<'PYEOF'
import sys, re

path = sys.argv[1]
with open(path) as f:
    text = f.read()

def resolve_conflict(match):
    ours = match.group(1)    # HEAD side
    theirs = match.group(2)  # incoming (7d687876) side
    # If HEAD side is empty/blank, keep incoming additions
    if not ours.strip():
        return theirs
    # Otherwise keep ours (shouldn't happen for this file)
    return ours

pattern = re.compile(
    r'<<<<<<< HEAD\n(.*?)=======\n(.*?)>>>>>>> [^\n]+\n',
    re.DOTALL
)
resolved = pattern.sub(resolve_conflict, text)
with open(path, 'w') as f:
    f.write(resolved)
print(f"    Resolved {path}")
PYEOF
        ;;
      *)
        echo "ERROR: Unknown conflict in $FILE — manual resolution required."
        echo "Resolve, then: git add $FILE && git commit -m '$COMMIT_MSG' && bun run dist:desktop:dmg"
        exit 1
        ;;
    esac
  done

  # Also ensure DiffPanel.tsx has gitBranchesQueryOptions + isGitRepo
  # (the cherry-pick may auto-merge the import line incorrectly)
  DIFF_PANEL="apps/web/src/components/DiffPanel.tsx"
  if ! grep -q "gitBranchesQueryOptions" "$DIFF_PANEL"; then
    sed -i '' 's|import { gitDiffQueryOptions } from "~/lib/gitReactQuery";|import { gitBranchesQueryOptions, gitDiffQueryOptions } from "~/lib/gitReactQuery";|' "$DIFF_PANEL"
  fi
  if ! grep -q "isGitRepo" "$DIFF_PANEL"; then
    sed -i '' 's|const activeCwd = activeThread?.worktreePath ?? activeProject?.cwd;|const activeCwd = activeThread?.worktreePath ?? activeProject?.cwd;\n  const gitBranchesQuery = useQuery(gitBranchesQueryOptions(activeCwd ?? null));\n  const isGitRepo = gitBranchesQuery.data?.isRepo ?? true;|' "$DIFF_PANEL"
  fi

  git add -A
fi

echo "==> Creating squash commit..."
git commit -m "$COMMIT_MSG"

echo "==> Building macOS DMG..."
bun run dist:desktop:dmg

echo ""
echo "Done. hux-fork is one commit ahead of origin/main."
git log --oneline origin/main..HEAD
