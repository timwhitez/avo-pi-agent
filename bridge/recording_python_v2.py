#!/usr/bin/env python3
"""Transparent ARC JSONL recorder with supervisor-marker synchronization.

Acts as the ARC_PYTHON executable while delegating to AVO_REAL_PYTHON. It keeps
stdout protocol-compatible, forwards stderr, records exact private ARC boundary
events, and emits bounded supervisor markers from persistent memory without
copying raw supervisor text into the trace.
"""

from __future__ import annotations

import collections
import datetime as dt
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import threading
import time
from typing import Any, TextIO

RUN_ID = os.environ.get("AVO_REAL_RUN_ID") or os.environ.get("AVO_UI_RUN_ID") or f"local-{int(time.time())}"
REAL_PYTHON = os.environ.get("AVO_REAL_PYTHON", sys.executable)
TRACE_ROOT = pathlib.Path(os.environ.get("AVO_TRAJECTORY_DIR", f"runs/private/trajectories/{RUN_ID}")).resolve()
TRACE_ROOT.mkdir(parents=True, exist_ok=True)
TRACE_PATH = TRACE_ROOT / "arc-boundary.jsonl"
MEMORY_ROOT = pathlib.Path(os.environ.get("AVO_MEMORY_DIR", "state/memory")).resolve()
MAX_CAPTURE_CHARS = 4_000_000
FSYNC_INTERVAL = 16

_lock = threading.Lock()
_sequence = 0
_since_fsync = 0
_pending: collections.deque[dict[str, Any]] = collections.deque()
_context: dict[str, Any] = {"game_id": None, "episode": 0, "turn": 0, "levels_completed": 0}
_supervisor_counts: dict[str, int] = {}
_memory_files: dict[str, pathlib.Path | None] = {}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def stable_hash(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def parse_json(line: str) -> Any | None:
    try:
        return json.loads(line)
    except Exception:
        return None


def bounded(value: Any) -> Any:
    serialized = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if len(serialized) <= MAX_CAPTURE_CHARS:
        return value
    return {"truncated": True, "sha256": hashlib.sha256(serialized.encode()).hexdigest(), "chars": len(serialized)}


def append_record(kind: str, payload: dict[str, Any], *, force_sync: bool = False) -> None:
    global _sequence, _since_fsync
    with _lock:
        _sequence += 1
        record = {
            "schema_version": 2,
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
            _since_fsync += 1
            if force_sync or _since_fsync >= FSYNC_INTERVAL:
                os.fsync(handle.fileno())
                _since_fsync = 0


def request_reader(source: TextIO, target: TextIO) -> None:
    for line in source:
        parsed = parse_json(line)
        if isinstance(parsed, dict):
            operation = str(parsed.get("op") or parsed.get("operation") or parsed.get("command") or parsed.get("method") or "unknown").lower()
            parameters = parsed.get("params") if isinstance(parsed.get("params"), dict) else parsed
            game_id = parameters.get("game_id") or parameters.get("gameId") or parsed.get("game_id") or parsed.get("gameId")
            if game_id:
                _context["game_id"] = str(game_id).lower()
            if operation in {"open", "make"}:
                _context["episode"] = 0
                _context["turn"] = 0
                _context["levels_completed"] = 0
            elif operation == "reset":
                _context["episode"] = int(_context.get("episode", 0)) + 1
                _context["turn"] = 0
            elif operation in {"step", "act"}:
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


def unwrap_response(response: dict[str, Any]) -> dict[str, Any]:
    for key in ("result", "data", "frame_data", "frameData"):
        value = response.get(key)
        if isinstance(value, dict):
            return value
    return response


def derive_transition(request: dict[str, Any] | None, response: dict[str, Any]) -> dict[str, Any]:
    body = unwrap_response(response)
    frame = body.get("frame")
    state = body.get("state")
    levels = body.get("levels_completed", body.get("levelsCompleted"))
    win_levels = body.get("win_levels", body.get("winLevels"))
    available = body.get("available_actions", body.get("availableActions"))
    if isinstance(levels, int):
        prior = int(_context.get("levels_completed", 0))
        level_delta = levels - prior
        _context["levels_completed"] = levels
    else:
        level_delta = None
    raw_request = request.get("request", {}) if request else {}
    parameters = raw_request.get("params") if isinstance(raw_request.get("params"), dict) else raw_request
    action = parameters.get("action") or parameters.get("action_name") or parameters.get("actionName")
    action_data = parameters.get("data") or parameters.get("action_data") or parameters.get("actionData")
    reasoning = parameters.get("reasoning")
    reasoning_text = json.dumps(reasoning, ensure_ascii=False) if reasoning is not None else ""
    return {
        "operation": request.get("operation") if request else "unmatched",
        "request_sha256": request.get("request_sha256") if request else None,
        "response_sha256": stable_hash(response),
        "action": action,
        "action_data": bounded(action_data),
        "reasoning_sha256": hashlib.sha256(reasoning_text.encode()).hexdigest() if reasoning_text else None,
        "reasoning_mentions_supervisor": bool(reasoning_text and any(term in reasoning_text.lower() for term in ("supervisor", "stagnat", "cycle", "plateau"))),
        "frame": bounded(frame),
        "frame_sha256": stable_hash(frame) if frame is not None else None,
        "state": state,
        "levels_completed": levels,
        "level_delta": level_delta,
        "win_levels": win_levels,
        "available_actions": available,
        "ok": response.get("ok", body.get("ok")),
        "error_class": type(response.get("error")).__name__ if response.get("error") is not None else None,
        "response": bounded(response),
    }


def find_memory_file(game_id: str) -> pathlib.Path | None:
    if game_id in _memory_files:
        return _memory_files[game_id]
    direct = MEMORY_ROOT / f"{game_id}.json"
    if direct.exists():
        _memory_files[game_id] = direct
        return direct
    if MEMORY_ROOT.exists():
        for file in MEMORY_ROOT.rglob("*.json"):
            try:
                value = json.loads(file.read_text(encoding="utf-8"))
                candidate = str(value.get("gameId") or value.get("game_id") or "").lower()
                if candidate == game_id:
                    _memory_files[game_id] = file
                    return file
            except Exception:
                continue
    _memory_files[game_id] = None
    return None


def supervisor_entries(value: Any) -> list[Any]:
    found: list[Any] = []
    visited: set[int] = set()

    def visit(node: Any, depth: int = 0) -> None:
        if depth > 5 or id(node) in visited:
            return
        if isinstance(node, (dict, list)):
            visited.add(id(node))
        if isinstance(node, dict):
            for key, child in node.items():
                normalized = key.lower().replace("_", "")
                if "supervisor" in normalized and isinstance(child, list):
                    found.extend(child)
                elif normalized in {"evolution", "lineage", "history", "state"}:
                    visit(child, depth + 1)
        elif isinstance(node, list):
            for child in node[:500]:
                visit(child, depth + 1)

    visit(value)
    unique: list[Any] = []
    seen: set[str] = set()
    for entry in found:
        digest = stable_hash(entry)
        if digest not in seen:
            seen.add(digest)
            unique.append(entry)
    return unique


def extract_evidence_refs(entry: Any) -> list[str]:
    if not isinstance(entry, dict):
        return []
    candidates = [
        entry.get("evidenceRefs"), entry.get("evidence_refs"),
        entry.get("trigger", {}).get("evidenceRefs") if isinstance(entry.get("trigger"), dict) else None,
        entry.get("trigger", {}).get("evidence_refs") if isinstance(entry.get("trigger"), dict) else None,
    ]
    for candidate in candidates:
        if isinstance(candidate, list):
            return [str(value)[:160] for value in candidate[:50]]
    return []


def direction_count(entry: Any) -> int:
    if not isinstance(entry, dict):
        return 0
    for key in ("directions", "alternatives", "recommendations"):
        value = entry.get(key)
        if isinstance(value, list):
            return len(value)
    return 0


def sync_supervisor_markers(game_id: str | None) -> None:
    if not game_id:
        return
    file = find_memory_file(game_id)
    if not file or not file.exists():
        return
    try:
        memory = json.loads(file.read_text(encoding="utf-8"))
        entries = supervisor_entries(memory)
    except Exception:
        return
    previous = _supervisor_counts.get(game_id, 0)
    if len(entries) <= previous:
        return
    for index, entry in enumerate(entries[previous:], start=previous):
        refs = extract_evidence_refs(entry)
        append_record("supervisor.intervention", {
            "intervention_index": index,
            "intervention_sha256": stable_hash(entry),
            "evidence_refs": refs,
            "evidence_backed": bool(refs),
            "direction_count": direction_count(entry),
        })
    _supervisor_counts[game_id] = len(entries)


def main() -> int:
    if len(sys.argv) < 2:
        print("recording_python_v2.py expects the bridge script path", file=sys.stderr)
        return 64
    command = [REAL_PYTHON, *sys.argv[1:]]
    append_record("bridge.wrapper_start", {
        "python_source": "configured-venv" if os.environ.get("AVO_REAL_PYTHON") else "current-interpreter",
        "script_name": pathlib.Path(sys.argv[1]).name,
        "supervisor_sync": True,
    }, force_sync=True)
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
        parsed = parse_json(line)
        if isinstance(parsed, dict):
            request = _pending.popleft() if _pending else None
            append_record("arc.response", derive_transition(request, parsed))
            sync_supervisor_markers(_context.get("game_id"))
        else:
            append_record("arc.stdout_noise", {"sha256": hashlib.sha256(line.encode()).hexdigest(), "chars": len(line)})
        sys.stdout.write(line)
        sys.stdout.flush()

    code = child.wait()
    sync_supervisor_markers(_context.get("game_id"))
    input_thread.join(timeout=1)
    error_thread.join(timeout=1)
    append_record("bridge.wrapper_end", {"exit_code": code, "pending_requests": len(_pending)}, force_sync=True)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
