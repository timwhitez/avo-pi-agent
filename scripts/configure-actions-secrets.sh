#!/usr/bin/env bash
set -euo pipefail

repo="${1:-timwhitez/avo-pi-agent}"

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: GitHub CLI (gh) is required." >&2
  exit 1
fi

gh auth status >/dev/null

set_secret() {
  local name="$1"
  local prompt="$2"
  local value

  printf '%s: ' "$prompt" >&2
  IFS= read -r -s value
  printf '\n' >&2
  if [[ -z "$value" ]]; then
    echo "ERROR: $name cannot be empty." >&2
    return 1
  fi

  # gh encrypts the value locally and reads it from stdin when --body is omitted.
  # The value is therefore absent from argv, shell history, repository files and logs.
  printf '%s' "$value" | gh secret set "$name" --repo "$repo" --app actions
  unset value
  echo "Configured $name for $repo."
}

set_secret AVO_PROVIDER_BASE_URL "Provider base URL"
set_secret AVO_PROVIDER_API_KEY "Provider API key"
set_secret AVO_PROVIDER_MODEL "Provider model ID"

printf 'Configure optional ARC_API_KEY now? [y/N]: ' >&2
IFS= read -r answer
case "${answer:-}" in
  y|Y|yes|YES)
    set_secret ARC_API_KEY "ARC API key"
    ;;
esac

gh variable set AVO_PROVIDER_REASONING_EFFORT --repo "$repo" --body max

echo
echo "Configured repository secret names:"
gh secret list --repo "$repo" --app actions --json name --jq '.[].name' \
  | grep -E '^(AVO_PROVIDER_BASE_URL|AVO_PROVIDER_API_KEY|AVO_PROVIDER_MODEL|ARC_API_KEY)$' \
  | sort || true

echo
echo "No secret value was written to this repository or printed by this script."
