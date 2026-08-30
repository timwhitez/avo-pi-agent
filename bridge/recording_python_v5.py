#!/usr/bin/env python3
"""Protocol-transparent, EOF-safe full-evidence ARC recorder.

This executable is used as ARC_PYTHON and delegates the official bridge script
to AVO_REAL_PYTHON. It supports both `method + params` and legacy operation
shapes, preserves stdout byte-for-byte, forwards stderr, and records only
private artifacts:

- exact ARC request/response transitions and private frames;
- bounded supervisor markers (hash, evidence refs, direction count);
- hash/count durable memory and hypothesis-journal changes;
- no provider credential, endpoint, model ID, or raw private reasoning text.
"""

from __future__ import annotations

import collections
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import threading
import time
from typing import Any, TextIO

RUN_ID = os.environ.get("AVO_REAL_RUN_ID") or os.environ.get("AVO_UI_RUN_ID") or f"local-{int(time.time())}"
REAL_PYTHON = os.environ.get("AVO_REAL_PYTHON", sys.executable)
TRACE_ROOT = pathlib.Path(os.environ.get("AVO_TRAJECTORY_DIR", f"runs/private/trajectories/{RUN_ID}")).resolve()
TRACE_ROOT.mkdir(parents=True, exist_ok=True)
ARC_TRACE = TRACE_ROOT / "arc-boundary.jsonl"
MEMORY_TRACE = TRACE_ROOT / "memory-events.jsonl"
MEMORY_ROOT = pathlib.Path(os.environ.get("AVO_MEMORY_DIR", "state/memory")).resolve()
POLL_SECONDS = max(0.1, float(os.environ.get("AVO_MEMORY_WATCH_INTERVAL", "0.5")))
MAX_CAPTURE_CHARS = 4_000_000
FSYNC_INTERVAL = 16

_lock = threading.Lock()
_stop = threading.Event()
_pending: collections.deque[dict[str, Any]] = collections.deque()
_sequence = {"arc": 0, "memory": 0}
_since_fsync = {"arc": 0, "memory": 0}
_seen_memory_files: dict[str, str] = {}
EVIDENCE_ID = re.compile(r"evidence-[0-9]{6,}-[a-f0-9]{12}")
_seen_supervisor_count: dict[str, int] = {}
_memory_file_cache: dict[str, pathlib.Path | None] = {}
_context: dict[str, Any] = {"game_id": None, "episode": 0, "turn": 0, "levels_completed": 0}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).hexdigest()


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


def append_record(channel: str, kind: str, payload: dict[str, Any], *, force_sync: bool = False) -> None:
    target = ARC_TRACE if channel == "arc" else MEMORY_TRACE
    with _lock:
        _sequence[channel] += 1
        record = {
            "schema_version": 5,
            "run_id": RUN_ID,
            "sequence": _sequence[channel],
            "at": utc_now(),
            "monotonic_ns": time.monotonic_ns(),
            "kind": kind,
            "game_id": _context.get("game_id"),
            "episode": _context.get("episode", 0),
            "turn": _context.get("turn", 0),
            **bounded(payload),
        }
        with target.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
            handle.flush()
            _since_fsync[channel] += 1
            if force_sync or _since_fsync[channel] >= FSYNC_INTERVAL:
                os.fsync(handle.fileno())
                _since_fsync[channel] = 0


def operation_and_params(request: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    operation = str(
        request.get("method")
        or request.get("op")
        or request.get("operation")
        or request.get("command")
        or "unknown"
    ).lower()
    params = request.get("params") if isinstance(request.get("params"), dict) else request
    return operation, params


def stdin_relay(source: TextIO, target: TextIO) -> None:
    try:
        for line in source:
            request = parse_json(line)
            if isinstance(request, dict):
                operation, params = operation_and_params(request)
                game_id = params.get("game_id") or params.get("gameId") or request.get("game_id") or request.get("gameId")
                if game_id:
                    _context["game_id"] = str(game_id).lower()
                if operation in {"open", "make"}:
                    _context.update({"episode": 0, "turn": 0, "levels_completed": 0})
                elif operation == "reset":
                    _context["episode"] = int(_context.get("episode", 0)) + 1
                    _context["turn"] = 0
                elif operation in {"step", "act"}:
                    _context["turn"] = int(_context.get("turn", 0)) + 1
                pending = {
                    "request_id": request.get("id"),
                    "operation": operation,
                    "params": bounded(params),
                    "request_sha256": canonical_hash(request),
                    "received_at": utc_now(),
                    "game_id": _context.get("game_id"),
                    "episode": _context.get("episode", 0),
                    "turn": _context.get("turn", 0),
                }
                _pending.append(pending)
                append_record("arc", "arc.request", pending)
            else:
                append_record("arc", "arc.stdin_noise", {
                    "sha256": hashlib.sha256(line.encode()).hexdigest(), "chars": len(line),
                })
            target.write(line)
            target.flush()
    finally:
        try:
            target.close()
        except Exception:
            pass


def stderr_relay(source: TextIO, target: TextIO) -> None:
    for line in source:
        target.write(line)
        target.flush()


def unwrap_response(response: dict[str, Any]) -> dict[str, Any]:
    for key in ("result", "data", "frame_data", "frameData"):
        child = response.get(key)
        if isinstance(child, dict):
            return child
    return response


def pop_pending(response: dict[str, Any]) -> dict[str, Any] | None:
    response_id = response.get("id")
    if response_id is not None:
        for index, request in enumerate(_pending):
            if request.get("request_id") == response_id:
                del _pending[index]
                return request
    return _pending.popleft() if _pending else None


def transition_record(request: dict[str, Any] | None, response: dict[str, Any]) -> dict[str, Any]:
    body = unwrap_response(response)
    frame = body.get("frame")
    levels = body.get("levels_completed", body.get("levelsCompleted"))
    prior_levels = int(_context.get("levels_completed", 0))
    level_delta = levels - prior_levels if isinstance(levels, int) else None
    if isinstance(levels, int):
        _context["levels_completed"] = levels
    params = request.get("params", {}) if request else {}
    action = params.get("action") or params.get("action_name") or params.get("actionName")
    action_data = params.get("data") or params.get("action_data") or params.get("actionData")
    reasoning = params.get("reasoning")
    reasoning_text = json.dumps(reasoning, ensure_ascii=False) if reasoning is not None else ""
    return {
        "request_id": request.get("request_id") if request else response.get("id"),
        "operation": request.get("operation") if request else "unmatched",
        "request_sha256": request.get("request_sha256") if request else None,
        "response_sha256": canonical_hash(response),
        "action": action,
        "action_data": bounded(action_data),
        "reasoning_sha256": hashlib.sha256(reasoning_text.encode()).hexdigest() if reasoning_text else None,
        "reasoning_mentions_supervisor": bool(reasoning_text and any(term in reasoning_text.lower() for term in ("supervisor", "stagnat", "cycle", "plateau"))),
        "frame": bounded(frame),
        "frame_sha256": canonical_hash(frame) if frame is not None else None,
        "state": body.get("state"),
        "levels_completed": levels,
        "level_delta": level_delta,
        "win_levels": body.get("win_levels", body.get("winLevels")),
        "available_actions": body.get("available_actions", body.get("availableActions")),
        "ok": response.get("ok", body.get("ok")),
        "error_present": response.get("error") is not None or body.get("error") is not None,
        "response": bounded(response),
    }


def find_memory_file(game_id: str) -> pathlib.Path | None:
    if game_id in _memory_file_cache:
        return _memory_file_cache[game_id]
    direct = MEMORY_ROOT / f"{game_id}.json"
    if direct.exists():
        _memory_file_cache[game_id] = direct
        return direct
    if MEMORY_ROOT.exists():
        for file in MEMORY_ROOT.rglob("*.json"):
            try:
                memory = json.loads(file.read_text(encoding="utf-8"))
                candidate = str(memory.get("gameId") or memory.get("game_id") or "").lower()
                if candidate == game_id:
                    _memory_file_cache[game_id] = file
                    return file
            except Exception:
                continue
    _memory_file_cache[game_id] = None
    return None


def list_value(value: dict[str, Any], *keys: str) -> list[Any]:
    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, list):
            return candidate
    return []


def dict_value(value: dict[str, Any], *keys: str) -> dict[str, Any]:
    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, dict):
            return candidate
    return {}


def supervisor_entries(memory: dict[str, Any]) -> list[Any]:
    lineage = dict_value(memory, "lineage", "evolution")
    values = list_value(memory, "supervisorInterventions", "supervisor_interventions") or list_value(lineage, "supervisorInterventions", "supervisor_interventions")
    unique: list[Any] = []
    seen: set[str] = set()
    for entry in values:
        digest = canonical_hash(entry)
        if digest not in seen:
            seen.add(digest)
            unique.append(entry)
    return unique


def evidence_refs(entry: Any) -> list[str]:
    if not isinstance(entry, dict):
        return []
    trigger = entry.get("trigger") if isinstance(entry.get("trigger"), dict) else {}
    for candidate in (entry.get("evidenceRefs"), entry.get("evidence_refs"), trigger.get("evidenceRefs"), trigger.get("evidence_refs")):
        if isinstance(candidate, list):
            return [str(item)[:160] for item in candidate[:50]]
    return []


def direction_count(entry: Any) -> int:
    if not isinstance(entry, dict):
        return 0
    for key in ("directions", "alternatives", "recommendations"):
        candidate = entry.get(key)
        if isinstance(candidate, list):
            return len(candidate)
    return 0


def sync_supervisor(game_id: str | None) -> None:
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
    previous = _seen_supervisor_count.get(game_id, 0)
    for index, entry in enumerate(entries[previous:], start=previous):
        refs = evidence_refs(entry)
        append_record("arc", "supervisor.intervention", {
            "intervention_index": index,
            "intervention_sha256": canonical_hash(entry),
            "evidence_refs": refs,
            "evidence_backed": bool(refs),
            "direction_count": direction_count(entry),
        })
    _seen_supervisor_count[game_id] = len(entries)


def evaluation_outcome(record: Any) -> str:
    if not isinstance(record, dict):
        return "inconclusive"
    evaluation = record.get("evaluation") if isinstance(record.get("evaluation"), dict) else {}
    record_outcome = record.get("outcome")
    evaluation_outcome_value = evaluation.get("outcome")
    if record_outcome and evaluation_outcome_value and record_outcome != evaluation_outcome_value:
        return "inconclusive"
    declared = record_outcome or evaluation_outcome_value
    if evaluation.get("evaluator") == "system-expiry-v1":
        return "expired" if declared in {None, "expired"} else "inconclusive"
    if declared == "expired":
        return "expired"
    checks = evaluation.get("predictionChecks")
    evidence = evaluation.get("evidence")
    missing = evaluation.get("missingEvidenceRefs")
    exact_evidence = (
        isinstance(evidence, list)
        and bool(evidence)
        and all(
            isinstance(item, dict)
            and isinstance(item.get("id"), str)
            and EVIDENCE_ID.fullmatch(item["id"])
            for item in evidence
        )
    )
    if not isinstance(checks, dict) or not exact_evidence or not isinstance(missing, list) or missing:
        return "inconclusive"
    total = checks.get("totalClaims")
    matched = checks.get("matchedClaims")
    unmatched = checks.get("unmatchedPredictions")
    if (
        isinstance(total, bool)
        or not isinstance(total, int)
        or total < 1
        or isinstance(matched, bool)
        or not isinstance(matched, int)
        or matched < 0
        or matched > total
        or not isinstance(unmatched, list)
        or unmatched
    ):
        return "inconclusive"
    if (
        declared in {"confirmed", "contradicted"} or "evidenceBoundaryValid" in evaluation
    ) and evaluation.get("evidenceBoundaryValid") is not True:
        return "inconclusive"
    derived = "confirmed" if matched == total else "contradicted"
    return derived if declared in {None, derived} else "inconclusive"


def hypothesis_journal_projection(memory: dict[str, Any]) -> dict[str, Any]:
    journal = dict_value(memory, "hypothesisJournal")
    legacy = dict_value(memory, "lineage", "evolution")
    proposals = list_value(memory, "hypothesisProposals") or list_value(journal, "proposals") or list_value(memory, "candidateProposals", "proposals") or list_value(legacy, "proposals")
    evaluations = list_value(memory, "hypothesisEvaluations") or list_value(journal, "evaluations") or list_value(memory, "candidateAttempts", "attempts") or list_value(legacy, "attempts")
    outcomes = [evaluation_outcome(record) for record in evaluations]
    supervisors = supervisor_entries(memory)
    return {
        "proposal_count": len(proposals),
        "evaluation_count": len(evaluations),
        "confirmed_count": outcomes.count("confirmed"),
        "contradicted_count": outcomes.count("contradicted"),
        "inconclusive_count": outcomes.count("inconclusive"),
        "expired_count": outcomes.count("expired"),
        "supervisor_count": len(supervisors),
        "latest_proposal_sha256": canonical_hash(proposals[-1]) if proposals else None,
        "latest_evaluation_sha256": canonical_hash(evaluations[-1]) if evaluations else None,
        "latest_supervisor_sha256": canonical_hash(supervisors[-1]) if supervisors else None,
    }


def memory_projection(memory: dict[str, Any], game_id: str) -> dict[str, Any]:
    semantics = dict_value(memory, "actionSemantics", "action_semantics")
    fields = {
        "objects": list_value(memory, "objects"),
        "goals": list_value(memory, "goals"),
        "invariants": list_value(memory, "invariants"),
        "failed_hypotheses": list_value(memory, "failedHypotheses", "failed_hypotheses"),
        "proven_strategies": list_value(memory, "provenStrategies", "proven_strategies"),
        "notes": list_value(memory, "notes"),
    }
    projection: dict[str, Any] = {
        "game_id": game_id,
        "memory_sha256": canonical_hash(memory),
        "action_semantics_count": len(semantics),
        "action_semantics_sha256": canonical_hash(semantics),
        **hypothesis_journal_projection(memory),
    }
    for name, value in fields.items():
        projection[f"{name}_count"] = len(value)
        projection[f"{name}_sha256"] = canonical_hash(value)
    return projection


def scan_memory() -> None:
    if not MEMORY_ROOT.exists():
        return
    for file in MEMORY_ROOT.rglob("*.json"):
        try:
            raw = file.read_bytes()
            digest = hashlib.sha256(raw).hexdigest()
            key = str(file.resolve())
            if _seen_memory_files.get(key) == digest:
                continue
            memory = json.loads(raw.decode("utf-8"))
            if not isinstance(memory, dict):
                continue
            game_id = str(memory.get("gameId") or memory.get("game_id") or file.stem).lower()
            prior = _seen_memory_files.get(key)
            _seen_memory_files[key] = digest
            append_record("memory", "memory.snapshot", {
                **memory_projection(memory, game_id),
                "previous_file_sha256": prior,
                "file_sha256": digest,
            })
            append_record("memory", "hypothesis_journal.snapshot", {"game_id": game_id, **hypothesis_journal_projection(memory)})
        except Exception as error:
            append_record("memory", "memory.watch_error", {
                "file_name_sha256": hashlib.sha256(file.name.encode()).hexdigest(),
                "error_class": error.__class__.__name__,
            })


def memory_watcher() -> None:
    while not _stop.is_set():
        scan_memory()
        _stop.wait(POLL_SECONDS)
    scan_memory()


def main() -> int:
    if len(sys.argv) < 2:
        print("recording_python_v5.py expects the bridge script path", file=sys.stderr)
        return 64
    append_record("arc", "bridge.wrapper_start", {
        "script_name": pathlib.Path(sys.argv[1]).name,
        "method_protocol_supported": True,
        "durable_state_watch": True,
    }, force_sync=True)
    append_record("memory", "memory.watcher_start", {
        "memory_root_present": MEMORY_ROOT.exists(),
        "poll_interval_ms": int(POLL_SECONDS * 1000),
    }, force_sync=True)
    watcher = threading.Thread(target=memory_watcher, daemon=True)
    watcher.start()
    child = subprocess.Popen(
        [REAL_PYTHON, *sys.argv[1:]],
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
    input_thread = threading.Thread(target=stdin_relay, args=(sys.stdin, child.stdin), daemon=True)
    error_thread = threading.Thread(target=stderr_relay, args=(child.stderr, sys.stderr), daemon=True)
    input_thread.start()
    error_thread.start()
    for line in child.stdout:
        response = parse_json(line)
        if isinstance(response, dict):
            request = pop_pending(response)
            append_record("arc", "arc.response", transition_record(request, response))
            sync_supervisor(_context.get("game_id"))
        else:
            append_record("arc", "arc.stdout_noise", {
                "sha256": hashlib.sha256(line.encode()).hexdigest(), "chars": len(line),
            })
        sys.stdout.write(line)
        sys.stdout.flush()
    code = child.wait()
    sync_supervisor(_context.get("game_id"))
    _stop.set()
    watcher.join(timeout=2)
    input_thread.join(timeout=1)
    error_thread.join(timeout=1)
    append_record("arc", "bridge.wrapper_end", {"exit_code": code, "pending_requests": len(_pending)}, force_sync=True)
    append_record("memory", "memory.watcher_end", {"exit_code": code, "tracked_file_count": len(_seen_memory_files)}, force_sync=True)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
