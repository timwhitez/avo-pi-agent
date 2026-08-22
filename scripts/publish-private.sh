#!/usr/bin/env bash
set -euo pipefail

repo_name="${1:-avo-pi-arc-agi3}"
command -v gh >/dev/null 2>&1 || { echo "ERROR: GitHub CLI (gh) is required." >&2; exit 1; }
gh auth status >/dev/null

git rev-parse --is-inside-work-tree >/dev/null
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: commit or discard local changes before publication." >&2
  exit 1
fi

node scripts/secret-scan.mjs
git fsck --full --no-dangling >/dev/null

owner="$(gh api user --jq .login)"
full_name="${owner}/${repo_name}"
if gh repo view "$full_name" >/dev/null 2>&1; then
  echo "ERROR: repository already exists: $full_name" >&2
  exit 1
fi

gh repo create "$full_name" --private --source=. --remote=origin --push
visibility="$(gh repo view "$full_name" --json visibility --jq .visibility)"
if [[ "$visibility" != "PRIVATE" ]]; then
  echo "ERROR: repository was created but visibility is $visibility" >&2
  exit 1
fi
printf 'Published private repository: %s\n' "$full_name"
