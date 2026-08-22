#!/usr/bin/env python3
"""Transparent Python proxy that records private ARC bridge JSONL traffic.

Set ARC_PYTHON to this file and AVO_REAL_ARC_PYTHON to the actual interpreter.
The proxy forwards argv/stdin/stdout/stderr byte-for-byte at the line level while
writing a mode-0600 private JSONL transcript. Provider secrets are removed from
the child environment because the ARC bridge does not need them.
"""
from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import threading
import time
from typing import Any, TextIO


class Recorder:
    def __init__(self, file: pathlib.Path) -> None:
        file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.handle = file.open("a", encoding="utf-8")
        os.chmod(file, 0o600)
        self.lock = threading.Lock()
        self.sequence = 0

    def write(self, direction: str, line: str, **extra: Any) -> None:
        with self.lock:
            self.sequence += 1
            record: dict[str, Any] = {
                "schemaVersion": 1,
                "sequence": self.sequence,
                "timestampNs": time.time_ns(),
                "direction": direction,
                **extra,
            }
            stripped = line.rstrip("\r\n")
            try:
                record["payload"] = json.loads(stripped)
            except json.JSONDecodeError:
                record["text"] = stripped[-200_000:]
            self.handle.write(json.dumps(record, separators=(",", ":")) + "\n")
            self.handle.flush()

    def close(self) -> None:
        with self.lock:
            self.handle.close()


def main() -> int:
    real_python = os.environ.get("AVO_REAL_ARC_PYTHON") or sys.executable
    if pathlib.Path(real_python).resolve() == pathlib.Path(sys.argv[0]).resolve():
        raise SystemExit("AVO_REAL_ARC_PYTHON resolves to the recording proxy itself")

    trajectory_dir = pathlib.Path(os.environ.get("AVO_TRAJECTORY_DIR", "runs/trajectory")).resolve()
    run_id = safe(os.environ.get("AVO_REAL_RUN_ID", "manual"))
    log_file = trajectory_dir / run_id / f"bridge-{os.getpid()}.jsonl"
    recorder = Recorder(log_file)

    child_env = dict(os.environ)
    for name in (
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_MODEL",
        "ANTHROPIC_API_KEY",
        "GOOGLE_API_KEY",
        "GROQ_API_KEY",
        "OPENROUTER_API_KEY",
    ):
        child_env.pop(name, None)
    child_env["AVO_RECORDING_PROXY_ACTIVE"] = "1"

    recorder.write("process-start", "", argv=sys.argv[1:], interpreterHash=hash_path(real_python))
    child = subprocess.Popen(
        [real_python, *sys.argv[1:]],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        env=child_env,
    )
    assert child.stdin is not None
    assert child.stdout is not None
    assert child.stderr is not None

    threads = [
        threading.Thread(target=pump_input, args=(sys.stdin, child.stdin, recorder), daemon=True),
        threading.Thread(target=pump_output, args=(child.stdout, sys.stdout, recorder, "response"), daemon=True),
        threading.Thread(target=pump_output, args=(child.stderr, sys.stderr, recorder, "stderr"), daemon=True),
    ]
    for thread in threads:
        thread.start()

    status = child.wait()
    for thread in threads:
        thread.join(timeout=5)
    recorder.write("process-exit", "", status=status)
    recorder.close()
    return status


def pump_input(source: TextIO, target: TextIO, recorder: Recorder) -> None:
    try:
        for line in source:
            recorder.write("request", line)
            target.write(line)
            target.flush()
    except BrokenPipeError:
        return
    finally:
        try:
            target.close()
        except BrokenPipeError:
            pass


def pump_output(source: TextIO, target: TextIO, recorder: Recorder, direction: str) -> None:
    for line in source:
        recorder.write(direction, line)
        target.write(line)
        target.flush()


def safe(value: str) -> str:
    return "".join(character if character.isalnum() or character in "_.-" else "_" for character in value)[:120]


def hash_path(value: str) -> str:
    import hashlib

    return hashlib.sha256(str(pathlib.Path(value).resolve()).encode()).hexdigest()


if __name__ == "__main__":
    raise SystemExit(main())
