#!/usr/bin/env python3
"""Transparent Python executable wrapper that records the ARC JSONL boundary.

The Node bridge normally executes:  <ARC_PYTHON> bridge/arc_bridge.py
Set ARC_PYTHON to this executable and AVO_REAL_PYTHON to the actual venv Python.
This wrapper proxies stdin/stdout byte-for-byte while appending private JSONL
records. Provider credentials never cross this protocol boundary.
"""

from __future__ import annotations

import collections
import datetime as dt
import hashlib
import json
import os
import pathlib
import queue
import subprocess
import sys
import threading
import time
from typing import Any, TextIO

MAX_CAPTURE_CHARS = 4_000_000
RUN_ID = os.environ.get("AVO_REAL_RUN_ID") or os.environ.get("AVO_UI_RUN_ID") or f"local-{int(time.time())}"
REAL_PYTHON = os.environ.get("AVO_REAL_PYTHON", sys.executable)
TRAJECTORY_ROOT = pathlib.Path(
    os.environ.get("AVO_TRAJECTORY_DIR", f"runs/private/trajectories/{RUN_ID}")
).resolve()
TRAJECTORY_ROOT.mkdir(parents=True, exist_ok=True)
TRACE_PATH = TRAJECTORY_ROOT / "arc-boundary.jsonl"

_lock = threading.Lock()
_sequence = 0
_pending: collections.deque[dict[str, Any]] = collections.deque()
_context: dict[str, Any] = {
    "game_id": None,
    "episode": 0,
    "turn": 0,
    "levels_completed": 0,
}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def stable_hash(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def safe_json(line: str) -> Any | None:
    try:
        return json.loads(line)
    except Exception:
        return None


def bounded(value: Any) -> Any:
    serialized = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if len(serialized) <= MAX_CAPTURE_CHARS:
        return value
    return {
        "truncated": True,
        "sha256": hashlib.sha256(serialized.encode("utf-8")).hexdigest(),
        "chars": len(serialized),
    }


def append_record(kind: str, payload: dict[str, Any]) -> None:
    global _sequence
    with _lock:
        _sequence += 1
        record = {
            "schema_version": 1,
            "run_id": RUN_ID,
            "sequence": _sequence,
            "at": utc_now(),
            "monotonic_ns": time.monotonic_ns(),
            "kind": kind,
            "game_id": _context.get("game_id"),
            "episode": _context.get("episode", 0),
            "turn": _context.get("turn", 0),
            **bounded(payload),
        }
        with TRACE_PATH.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
            handle.flush()
            os.fsync(handle.fileno())


def request_reader(source: TextIO, target: TextIO) -> None:
    for line in source:
        parsed = safe_json(line)
        if isinstance(parsed, dict):
            operation = str(parsed.get("op") or parsed.get("operation") or parsed.get("command") or "unknown")
            game_id = parsed.get("game_id") or parsed.get("gameId")
            if game_id:
                _context["game_id"] = str(game_id)
            if operation in {"open", "make", "reset"}:
                if operation == "reset":
                    _context["episode"] = int(_context.get("episode", 0)) + 1
                    _context["turn"] = 0
            if operation in {"step", "act"}:
                _context["turn"] = int(_context.get("turn", 0)) + 1
            request = {
                "operation": operation,
                "request": bounded(parsed),
                "request_sha256": stable_hash(parsed),
                "received_at": utc_now(),
                "game_id": _context.get("game_id"),
                "episode": _context.get("episode", 0),
                "turn": _context.get("turn", 0),
            }
            _pending.append(request)
            append_record("arc.request", request)
        else:
            append_record("arc.stdin_noise", {"sha256": hashlib.sha256(line.encode()).hexdigest(), "chars": len(line)})
        target.write(line)
        target.flush()
    try:
        target.close()
    except Exception:
        pass


def stderr_reader(source: TextIO, target: TextIO) -> None:
    for line in source:
        target.write(line)
        target.flush()


def derive_transition(request: dict[str, Any] | None, response: dict[str, Any]) -> dict[str, Any]:
    frame = response.get("frame")
    state = response.get("state")
    levels = response.get("levels_completed", response.get("levelsCompleted"))
    win_levels = response.get("win_levels", response.get("winLevels"))
    available = response.get("available_actions", response.get("availableActions"))
    if isinstance(levels, int):
        prior = int(_context.get("levels_completed", 0))
        level_delta = levels - prior
        _context["levels_completed"] = levels
    else:
        level_delta = None
    request_payload = request.get("request", {}) if request else {}
    operation = request.get("operation") if request else "unmatched"
    action = request_payload.get("action") or request_payload.get("action_name") or request_payload.get("actionName")
    data = request_payload.get("data") or request_payload.get("action_data") or request_payload.get("actionData")
    return {
        "operation": operation,
        "request_sha256": request.get("request_sha256") if request else None,
        "response_sha256": stable_hash(response),
        "action": action,
        "action_data": bounded(data),
        "frame": bounded(frame),
        "frame_sha256": stable_hash(frame) if frame is not None else None,
        "state": state,
        "levels_completed": levels,
        "level_delta": level_delta,
        "win_levels": win_levels,
        "available_actions": available,
        "response": bounded(response),
    }


def main() -> int:
    if len(sys.argv) < 2:
        print("recording_python.py expects the bridge script path", file=sys.stderr)
        return 64
    command = [REAL_PYTHON, *sys.argv[1:]]
    append_record("bridge.wrapper_start", {
        "python_source": "configured-venv" if os.environ.get("AVO_REAL_PYTHON") else "current-interpreter",
        "script_name": pathlib.Path(sys.argv[1]).name,
    })
    child = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        env=os.environ.copy(),
    )
    assert child.stdin is not None and child.stdout is not None and child.stderr is not None
    input_thread = threading.Thread(target=request_reader, args=(sys.stdin, child.stdin), daemon=True)
    error_thread = threading.Thread(target=stderr_reader, args=(child.stderr, sys.stderr), daemon=True)
    input_thread.start()
    error_thread.start()

    for line in child.stdout:
        parsed = safe_json(line)
        if isinstance(parsed, dict):
            request = _pending.popleft() if _pending else None
            transition = derive_transition(request, parsed)
            append_record("arc.response", transition)
        else:
            append_record("arc.stdout_noise", {"sha256": hashlib.sha256(line.encode()).hexdigest(), "chars": len(line)})
        sys.stdout.write(line)
        sys.stdout.flush()

    code = child.wait()
    input_thread.join(timeout=1)
    error_thread.join(timeout=1)
    append_record("bridge.wrapper_end", {"exit_code": code, "pending_requests": len(_pending)})
    return code


if __name__ == "__main__":
    raise SystemExit(main())
