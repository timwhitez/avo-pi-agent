# Integrity-gated authoritative repair-v10 rerun

Replaces all earlier pending repair-v10 snapshots. A round can be clean only when recorder schema v5 is observed, `method + params` or legacy operations are recognized, every expected game has real step/act transitions, exact frame hashes exist, all registered detectors execute, parse errors are zero, and open findings are zero. No credential is stored here.
