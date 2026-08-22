#!/usr/bin/env bash
set -euo pipefail
PYTHON="${PYTHON:-python3.12}"
"$PYTHON" -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r bridge/requirements.txt
printf '\nARC bridge ready. Run: npm run demo:public\n'
