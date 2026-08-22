#!/usr/bin/env python3
"""Compose the exact ARC recorder with a private memory/lineage watcher.

This executable delegates protocol handling to recording_python_v2.py, while a
background watcher records bounded, hash-based durable-state changes. Raw memory
text remains in the separate private state artifact and is never copied into the
redacted report.
"""

from __future__ import annotations

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
TRACE_ROOT = pathlib.Path(os.environ.get("AVO_TRAJECTORY_DIR", f"runs/private/trajectories/{RUN_ID}")).resolve()
TRACE_ROOT.mkdir(parents=True, exist_ok=True)
MEMORY_TRACE = TRACE_ROOT / "memory-events.jsonl"
MEMORY_ROOT = pathlib.Path(os.environ.get("AVO_MEMORY_DIR", "state/memory")).resolve()
POLL_SECONDS = max(0.1, float(os.environ.get("AVO_MEMORY_WATCH_INTERVAL", "0.5")))

_lock = threading.Lock()
_stop = threading.Event()
_sequence = 0
_seen: dict[str, str] = {}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).hexdigest()


def pick_list(value: dict[str, Any], *keys: str) -> list[Any]:
    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, list):
            return candidate
    return []


def pick_dict(value: dict[str, Any], *keys: str) -> dict[str, Any]:
    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, dict):
            return candidate
    return {}


def lineage_projection(memory: dict[str, Any]) -> dict[str, Any]:
    lineage = pick_dict(memory, "lineage", "evolution")
    proposals = pick_list(memory, "proposals") or pick_list(lineage, "proposals")
    attempts = pick_list(memory, "attempts", "evaluatedAttempts") or pick_list(lineage, "attempts", "evaluatedAttempts")
    committed = pick_list(memory, "committed", "committedLineage") or pick_list(lineage, "committed", "committedLineage")
    supervisors = pick_list(memory, "supervisorInterventions", "supervisor_interventions") or pick_list(lineage, "supervisorInterventions", "supervisor_interventions")
    return {
        "proposal_count": len(proposals),
        "attempt_count": len(attempts),
        "committed_count": len(committed),
        "supervisor_count": len(supervisors),
        "latest_proposal_sha256": canonical_hash(proposals[-1]) if proposals else None,
        "latest_attempt_sha256": canonical_hash(attempts[-1]) if attempts else None,
        "latest_committed_sha256": canonical_hash(committed[-1]) if committed else None,
        "latest_supervisor_sha256": canonical_hash(supervisors[-1]) if supervisors else None,
    }


def memory_projection(memory: dict[str, Any], game_id: str) -> dict[str, Any]:
    semantics = pick_dict(memory, "actionSemantics", "action_semantics")
    objects = pick_list(memory, "objects")
    goals = pick_list(memory, "goals")
    invariants = pick_list(memory, "invariants")
    failures = pick_list(memory, "failedHypotheses", "failed_hypotheses")
    strategies = pick_list(memory, "provenStrategies", "proven_strategies")
    notes = pick_list(memory, "notes")
    return {
        "game_id": game_id,
        "memory_sha256": canonical_hash(memory),
        "action_semantics_count": len(semantics),
        "action_semantics_sha256": canonical_hash(semantics),
        "object_count": len(objects),
        "objects_sha256": canonical_hash(objects),
        "goal_count": len(goals),
        "goals_sha256": canonical_hash(goals),
        "invariant_count": len(invariants),
        "invariants_sha256": canonical_hash(invariants),
        "failed_hypothesis_count": len(failures),
        "failed_hypotheses_sha256": canonical_hash(failures),
        "proven_strategy_count": len(strategies),
        "proven_strategies_sha256": canonical_hash(strategies),
        "note_count": len(notes),
        "notes_sha256": canonical_hash(notes),
        **lineage_projection(memory),
    }


def append(kind: str, payload: dict[str, Any], force_sync: bool = False) -> None:
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
            **payload,
        }
        with MEMORY_TRACE.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
            handle.flush()
            if force_sync:
                os.fsync(handle.fileno())


def scan_memory() -> None:
    if not MEMORY_ROOT.exists():
        return
    for file in MEMORY_ROOT.rglob("*.json"):
        try:
            raw = file.read_bytes()
            digest = hashlib.sha256(raw).hexdigest()
            key = str(file.resolve())
            if _seen.get(key) == digest:
                continue
            memory = json.loads(raw.decode("utf-8"))
            if not isinstance(memory, dict):
                continue
            game_id = str(memory.get("gameId") or memory.get("game_id") or file.stem).lower()
            projection = memory_projection(memory, game_id)
            prior = _seen.get(key)
            _seen[key] = digest
            append("memory.snapshot", {
                **projection,
                "previous_file_sha256": prior,
                "file_sha256": digest,
            })
            append("lineage.snapshot", {
                "game_id": game_id,
                **lineage_projection(memory),
            })
        except Exception as error:
            append("memory.watch_error", {
                "file_name_sha256": hashlib.sha256(file.name.encode()).hexdigest(),
                "error_class": error.__class__.__name__,
            })


def watcher() -> None:
    while not _stop.is_set():
        scan_memory()
        _stop.wait(POLL_SECONDS)
    scan_memory()


def relay(source: TextIO, target: TextIO) -> None:
    try:
        for line in source:
            target.write(line)
            target.flush()
    finally:
        try:
            target.close()
        except Exception:
            pass


def main() -> int:
    if len(sys.argv) < 2:
        print("recording_python_v3.py expects the bridge script path", file=sys.stderr)
        return 64
    recorder = pathlib.Path(__file__).with_name("recording_python_v2.py")
    append("memory.watcher_start", {
        "memory_root_present": MEMORY_ROOT.exists(),
        "poll_interval_ms": int(POLL_SECONDS * 1000),
    }, force_sync=True)
    watch_thread = threading.Thread(target=watcher, daemon=True)
    watch_thread.start()
    child = subprocess.Popen(
        [sys.executable, str(recorder), *sys.argv[1:]],
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
    stdin_thread = threading.Thread(target=relay, args=(sys.stdin, child.stdin), daemon=True)
    stderr_thread = threading.Thread(target=relay, args=(child.stderr, sys.stderr), daemon=True)
    stdin_thread.start()
    stderr_thread.start()
    for line in child.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
    code = child.wait()
    _stop.set()
    watch_thread.join(timeout=2)
    stdin_thread.join(timeout=1)
    stderr_thread.join(timeout=1)
    append("memory.watcher_end", {"exit_code": code, "tracked_file_count": len(_seen)}, force_sync=True)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
