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

echo "==> Fetching origin..."
git fetch origin

echo "==> Resetting hux-fork to origin/main..."
git reset --hard origin/main

echo "==> Cherry-picking ${#COMMITS[@]} commits (no-commit)..."
if ! git cherry-pick --no-commit "${COMMITS[@]}"; then
  echo "==> Conflicts detected, attempting rerere auto-resolution..."
  git rerere

  UNRESOLVED="$(git diff --name-only --diff-filter=U 2>/dev/null || true)"
  if [ -n "$UNRESOLVED" ]; then
    echo "ERROR: Unresolved conflicts in:"
    echo "$UNRESOLVED"
    echo ""
    echo "Resolve conflicts, then run:"
    echo "  git add <files>"
    echo "  git commit -m '$COMMIT_MSG'"
    echo "  bun run dist:desktop:dmg"
    exit 1
  fi

  echo "==> All conflicts auto-resolved via rerere."
  git add -A
fi

echo "==> Creating squash commit..."
git commit -m "$COMMIT_MSG"

echo "==> Building macOS DMG..."
bun run dist:desktop:dmg

echo ""
echo "Done. hux-fork is one commit ahead of origin/main."
git log --oneline origin/main..HEAD
