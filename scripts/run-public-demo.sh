#!/usr/bin/env bash
set -euo pipefail
: "${OPENAI_BASE_URL:?set OPENAI_BASE_URL}"
: "${OPENAI_API_KEY:?set OPENAI_API_KEY}"
: "${OPENAI_MODEL:?set OPENAI_MODEL}"
export OPENAI_REASONING_EFFORT="${OPENAI_REASONING_EFFORT:-max}"
exec node src/cli.mjs run-public --all "$@"
