#!/usr/bin/env python3
"""Line-delimited JSON bridge between Node/Pi and the official arc-agi runtime.

The bridge deliberately exposes only environment discovery, game selection,
observation, step/reset, and scorecard operations. Provider credentials never
enter this process. One bridge process owns one Arcade instance so a full
public-suite run produces a cumulative scorecard.

ARC authentication defaults to the official toolkit's server-issued anonymous
key flow. The key is never emitted by this bridge: all official ARC loggers are
redirected to stderr and filtered before any record is written.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
from dataclasses import asdict, is_dataclass
from enum import Enum
from typing import Any

_ANONYMOUS_KEY_LOG = re.compile(r"(Got anonymous API key:\s*).+", re.IGNORECASE)
_SUPPORTED_AUTH_MODES = {"anonymous-auto", "registered"}


class _RedactArcSecrets(logging.Filter):
    """Remove server-issued ARC credentials from official SDK log records."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        if _ANONYMOUS_KEY_LOG.search(message):
            record.msg = _ANONYMOUS_KEY_LOG.sub(r"\1<redacted>", message)
            record.args = ()
        return True


def _stderr_handler() -> logging.Handler:
    handler = logging.StreamHandler(sys.stderr)
    handler.setLevel(logging.INFO)
    handler.addFilter(_RedactArcSecrets())
    handler.setFormatter(logging.Formatter("%(levelname)s:%(name)s:%(message)s"))
    return handler


def build_arc_logger() -> logging.Logger:
    """Create a stderr-only logger so SDK messages cannot corrupt JSONL stdout."""

    logger = logging.getLogger("avo.arc.bridge")
    logger.handlers.clear()
    logger.propagate = False
    logger.setLevel(logging.INFO)
    logger.addHandler(_stderr_handler())
    return logger


def redirect_official_arc_loggers() -> None:
    """Replace stdout handlers installed by arc-agi modules.

    `arc_agi.scorecard` installs its own `StreamHandler(sys.stdout)` at import
    time and disables propagation. Passing a logger to `Arcade` therefore does
    not cover it. Replacing every loaded `arc_agi*` logger handler here keeps
    stdout reserved exclusively for the JSONL protocol.
    """

    names = {"arc_agi"}
    names.update(
        name
        for name in logging.Logger.manager.loggerDict
        if name == "arc_agi" or name.startswith("arc_agi.")
    )
    for name in names:
        logger = logging.getLogger(name)
        logger.handlers.clear()
        logger.addHandler(_stderr_handler())
        logger.setLevel(logging.INFO)
        logger.propagate = False


def prepare_arc_auth() -> str:
    """Select registered auth or the official server-issued anonymous flow.

    `arc-agi` loads `.env.example` during import. Explicitly setting an empty
    environment value before that import prevents a placeholder from shadowing
    the SDK's anonymous-key bootstrap.
    """

    mode = os.getenv("AVO_ARC_AUTH_MODE", "anonymous-auto").strip().lower()
    if mode not in _SUPPORTED_AUTH_MODES:
        raise ValueError(
            f"Unsupported AVO_ARC_AUTH_MODE={mode!r}; expected one of "
            f"{sorted(_SUPPORTED_AUTH_MODES)}"
        )
    if mode == "anonymous-auto":
        os.environ["ARC_API_KEY"] = ""
    elif not os.getenv("ARC_API_KEY", "").strip():
        raise ValueError("registered ARC auth requires ARC_API_KEY")
    return mode


def arc_auth_metadata(arcade: Any, mode: str) -> dict[str, Any]:
    acquired = bool(str(getattr(arcade, "arc_api_key", "") or "").strip())
    return {
        "mode": mode,
        "keyAcquired": acquired,
        "keySource": (
            "official-anonymous-endpoint" if mode == "anonymous-auto" else "environment-secret"
        ),
    }


def fail(message: str) -> None:
    print(json.dumps({"ok": False, "error": message}), flush=True)


def jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Enum):
        return value.name
    if hasattr(value, "tolist"):
        return value.tolist()
    if hasattr(value, "model_dump"):
        return jsonable(value.model_dump())
    if is_dataclass(value):
        return jsonable(asdict(value))
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [jsonable(v) for v in value]
    if hasattr(value, "__dict__"):
        return jsonable(vars(value))
    return str(value)


def serialize_frame(raw: Any) -> dict[str, Any]:
    return {
        "game_id": getattr(raw, "game_id", None),
        "frame": jsonable(getattr(raw, "frame", [])),
        "state": jsonable(getattr(raw, "state", "UNKNOWN")),
        "levels_completed": int(getattr(raw, "levels_completed", 0) or 0),
        "win_levels": int(getattr(raw, "win_levels", 0) or 0),
        "guid": getattr(raw, "guid", None),
        "full_reset": bool(getattr(raw, "full_reset", False)),
        "available_actions": jsonable(getattr(raw, "available_actions", [])),
    }


def serialize_environment_info(item: Any) -> dict[str, Any]:
    return {
        "game_id": getattr(item, "game_id", None),
        "title": getattr(item, "title", None),
        "default_fps": getattr(item, "default_fps", None),
        "baseline_actions": jsonable(getattr(item, "baseline_actions", None)),
        "level_tags": jsonable(getattr(item, "level_tags", None)),
    }


def environment_list(arcade: Any) -> list[dict[str, Any]]:
    return [serialize_environment_info(item) for item in arcade.get_environments()]


def resolve_action(GameAction: Any, name: str) -> Any:
    normalized = str(name).upper()
    try:
        return GameAction[normalized]
    except Exception:
        if normalized.startswith("ACTION"):
            try:
                return GameAction.from_id(int(normalized.removeprefix("ACTION")))
            except Exception:
                pass
        if normalized == "RESET":
            try:
                return GameAction.from_id(0)
            except Exception:
                pass
        raise ValueError(f"Unknown GameAction: {name}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--game")
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args()

    try:
        auth_mode = prepare_arc_auth()
    except Exception as exc:
        fail(f"ARC authentication configuration failed: {type(exc).__name__}: {exc}")
        return 2

    try:
        import arc_agi
        from arc_agi import OperationMode
        from arcengine import GameAction
        redirect_official_arc_loggers()
    except Exception as exc:
        fail(
            "Official ARC runtime unavailable. Use Python 3.12 and run "
            f"scripts/setup-arc.sh. Import error: {exc}"
        )
        return 2

    try:
        arcade = arc_agi.Arcade(
            operation_mode=OperationMode.NORMAL,
            logger=build_arc_logger(),
        )
        auth = arc_auth_metadata(arcade, auth_mode)
        if not auth["keyAcquired"]:
            raise RuntimeError(
                "official ARC toolkit did not acquire an API key for the selected auth mode"
            )
        if args.list:
            print(
                json.dumps(
                    {
                        "ok": True,
                        "arc_auth": auth,
                        "environments": environment_list(arcade),
                    }
                ),
                flush=True,
            )
            return 0
        env = None
        current_game_id = None
        if args.game:
            env = arcade.make(args.game)
            if env is None:
                fail(f"Could not create ARC environment: {args.game}")
                return 3
            current_game_id = args.game
    except Exception as exc:
        fail(f"ARC initialization failed: {type(exc).__name__}: {exc}")
        return 3

    for line in sys.stdin:
        try:
            request = json.loads(line)
            command = request.get("command")
            if command == "list":
                response = {
                    "ok": True,
                    "arc_auth": auth,
                    "environments": environment_list(arcade),
                }
            elif command == "auth":
                response = {"ok": True, "arc_auth": auth}
            elif command == "open":
                requested_game = str(request.get("game_id") or "").strip()
                if not requested_game:
                    raise ValueError("open requires game_id")
                env = arcade.make(requested_game)
                if env is None:
                    raise ValueError(f"Could not create ARC environment: {requested_game}")
                current_game_id = requested_game
                response = {
                    "ok": True,
                    "game_id": current_game_id,
                    "frame": serialize_frame(env.observation_space),
                }
            elif command == "observe":
                if env is None:
                    raise ValueError("No game is open")
                response = {"ok": True, "frame": serialize_frame(env.observation_space)}
            elif command in ("step", "reset"):
                if env is None:
                    raise ValueError("No game is open")
                action_name = "RESET" if command == "reset" else request.get("action")
                action = resolve_action(GameAction, action_name)
                data = request.get("data") or {}
                if hasattr(action, "set_data"):
                    action.set_data(data)
                reasoning = request.get("reasoning")
                if reasoning is not None and not isinstance(reasoning, dict):
                    reasoning = {"text": str(reasoning)}
                raw = env.step(action, data=data, reasoning=reasoning)
                response = {"ok": True, "frame": serialize_frame(raw)}
            elif command == "scorecard":
                response = {
                    "ok": True,
                    "arc_auth": auth,
                    "scorecard": jsonable(arcade.get_scorecard()),
                }
            elif command == "close":
                print(json.dumps({"ok": True}), flush=True)
                break
            else:
                raise ValueError(f"Unknown command: {command}")
            print(json.dumps(response, separators=(",", ":")), flush=True)
        except Exception as exc:
            fail(f"{type(exc).__name__}: {exc}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
