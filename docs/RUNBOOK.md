# Public demo runbook

## Prerequisites

- Node.js 22.19.0 or newer.
- Python 3.12.
- Network access for npm, PyPI, the configured model endpoint, and the first
  ARC public-environment download.
- An ARC API key when using the official online scorecard service.

## Setup

The isolated option is `docker compose -f compose.example.yml run --rm avo-arc`.
For a native installation, continue below.

```bash
npm install --ignore-scripts
./scripts/setup-arc.sh
cp .env.example .env
chmod 600 .env
```

Fill `.env` locally. Do not paste credentials into source files or command-line
arguments because shell history and process listings may retain them.

## Validate the provider

```bash
npm run provider:check
```

The command emits only a redacted capability summary. It does not print the
endpoint, model identifier, key, request headers or raw provider payload.

## Validate the ARC runtime

```bash
node src/cli.mjs list-public
```

The official public set should be discovered dynamically from `arc-agi`; no
game IDs or environment files are embedded in this repository.

## Run one game, then all public games

```bash
node src/cli.mjs run-public --game=ls20
npm run demo:public
```

Reports are written under `runs/`, which is gitignored. A report contains game
state, levels, action counts and the official scorecard object when the ARC SDK
returns one. It never contains provider configuration.

## Verify before publication

```bash
npm run verify

git status --short
```

Use the repository's secret scanner before any push.
