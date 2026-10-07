#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
checkout="$PWD"
browser_python=/usr/bin/python3.12
browser_venv="$checkout/.venv-browser"
for option in "$@"; do
  case "$option" in
    --python=/*) browser_python="${option#*=}";;
    --venv=/*) browser_venv="${option#*=}";;
    *) echo 'Usage: setup-browser.sh [--python=/absolute/python3.12] [--venv=/absolute/private-venv]' >&2; exit 2;;
  esac
done
if [[ -e "$browser_venv" || -L "$browser_venv" ]]; then
  echo 'Refusing existing installation; choose a new private venv or explicitly remove the recorded private installation.' >&2
  exit 1
fi
if [[ "$browser_venv" == "$checkout/.venv" ]]; then exit 1; fi
"$browser_python" -I -c 'import platform,sysconfig; assert platform.python_version()=="3.12.3" and sysconfig.get_config_var("SOABI")=="cpython-312-x86_64-linux-gnu", "unsupported Python/ABI"'
env -i PATH=/usr/bin:/bin LANG=C.UTF-8 "$browser_python" -I -m venv "$browser_venv"
"$browser_venv/bin/python" -I -m pip --version > "$browser_venv/seed-pip-version.txt"
chmod 600 "$browser_venv/seed-pip-version.txt"
env -i PATH=/usr/bin:/bin LANG=C.UTF-8 PIP_CONFIG_FILE=/dev/null "$browser_venv/bin/python" -I -m pip install --no-compile --index-url https://pypi.org/simple --require-hashes --only-binary=:all: -r "$checkout/requirements/browser/linux-x86_64-cp312.lock"
mkdir -m 700 "$browser_venv/installer-cwd"
cd -- "$browser_venv/installer-cwd"
env -i PATH=/usr/bin:/bin LANG=C.UTF-8 PYTHON_DOTENV_DISABLED=1 BROWSER_USE_SETUP_LOGGING=false "$browser_venv/bin/python" -I "$checkout/scripts/browser-launch.py" inventory > "$browser_venv/receipt.json"
chmod 600 "$browser_venv/receipt.json"
