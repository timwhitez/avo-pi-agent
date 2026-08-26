#!/usr/bin/env python3
"""Execute model-authored analysis code inside a bounded per-game workspace.

This is a defense-in-depth helper, not a substitute for the container/OS
sandbox. It strips runtime secrets, applies resource limits, blocks networking
and subprocess creation through Python audit hooks, and denies writes outside
its workspace root.
"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import pathlib
import resource
import sys
import traceback
from typing import Any


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--cpu-seconds", type=int, default=5)
    parser.add_argument("--memory-mb", type=int, default=512)
    args = parser.parse_args()

    root = pathlib.Path(args.root).resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chdir(root)
    sys.path.insert(0, str(root))
    set_limits(args.cpu_seconds, args.memory_mb)
    install_audit_guard(root)

    request = json.load(sys.stdin)
    code = str(request.get("code") or "")
    if not code.strip():
        print(json.dumps({"ok": False, "error": "code is empty"}))
        return 2

    stdout = io.StringIO()
    stderr = io.StringIO()
    namespace: dict[str, Any] = {
        "__name__": "__avo_workspace__",
        "__file__": str(root / "<agent-code>"),
    }
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            exec(compile(code, "<agent-code>", "exec"), namespace, namespace)
        response = {
            "ok": True,
            "stdout": stdout.getvalue()[-100_000:],
            "stderr": stderr.getvalue()[-100_000:],
        }
    except BaseException as exc:  # include SystemExit; never crash the bridge protocol
        response = {
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "stdout": stdout.getvalue()[-100_000:],
            "stderr": (stderr.getvalue() + traceback.format_exc())[-100_000:],
        }
    print(json.dumps(response, separators=(",", ":")))
    return 0 if response["ok"] else 1


def set_limits(cpu_seconds: int, memory_mb: int) -> None:
    cpu = max(1, min(cpu_seconds, 30))
    memory = max(64, min(memory_mb, 2048)) * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 1))
    resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
    resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024, 8 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))


def install_audit_guard(root: pathlib.Path) -> None:
    stdlib_roots = [pathlib.Path(sys.base_prefix).resolve(), pathlib.Path(sys.exec_prefix).resolve()]

    def inside(candidate: pathlib.Path, allowed_root: pathlib.Path) -> bool:
        try:
            candidate.relative_to(allowed_root)
            return True
        except ValueError:
            return False

    def guard(event: str, args: tuple[Any, ...]) -> None:
        if event.startswith(("socket.", "subprocess.", "http.client", "urllib.Request")):
            raise PermissionError(f"sandbox blocked audit event: {event}")
        if event in {"os.system", "os.posix_spawn", "os.spawn", "pty.spawn"}:
            raise PermissionError(f"sandbox blocked audit event: {event}")
        if event != "open" or not args:
            return
        target = args[0]
        if isinstance(target, int):
            return
        file_path = pathlib.Path(os.fspath(target))
        resolved = (root / file_path).resolve() if not file_path.is_absolute() else file_path.resolve()
        mode = str(args[1] if len(args) > 1 else "r")
        writing = any(flag in mode for flag in "wax+")
        if inside(resolved, root):
            return
        if not writing and any(inside(resolved, prefix) for prefix in stdlib_roots):
            return
        raise PermissionError(f"sandbox denied file access outside workspace: {resolved}")

    sys.addaudithook(guard)


if __name__ == "__main__":
    raise SystemExit(main())
