#!/usr/bin/env python3
"""EOF-safe entry point for the full-evidence ARC recorder.

The durable-state implementation remains in recording_python_v3.py. This entry
point replaces only its stream relay with an EOF-closing version before calling
main(), avoiding branch-time source mutation and preserving protocol streaming.
"""

from __future__ import annotations

from typing import TextIO

import recording_python_v3 as implementation


def relay_and_close(source: TextIO, target: TextIO) -> None:
    try:
        for line in source:
            target.write(line)
            target.flush()
    finally:
        try:
            target.close()
        except Exception:
            pass


implementation.relay = relay_and_close


if __name__ == "__main__":
    raise SystemExit(implementation.main())
