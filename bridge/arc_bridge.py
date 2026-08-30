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
from datetime import datetime, timezone
from enum import Enum
from typing import Any

_ANONYMOUS_KEY_LOG = re.compile(r"(Got anonymous API key:\s*).+", re.IGNORECASE)
_ARC_IDENTIFIER_LOG = re.compile(
    r"((?<!\.)\b(?:guid|scorecard(?:_id)?|card_id)\b[\"']?"
    r"\s*[:=]\s*[\"']?)"
    r"([^\"',;\s}/]+)",
    re.IGNORECASE,
)
_ARC_GUID_WORD_LOG = re.compile(
    r"(\bguid\s+)([^\"',;\s}/]+)", re.IGNORECASE
)
_SCORECARD_API_PATH_LOG = re.compile(
    r"(/api/scorecard/)[^/?#\s;\"']+", re.IGNORECASE
)
_RECORDING_PATH_LOG = re.compile(r"(\brecordings?/)[^\s\"']+", re.IGNORECASE)
_SUPPORTED_AUTH_MODES = {"anonymous-auto", "registered"}


def redact_arc_private_material(value: Any) -> str:
    """Remove ARC credentials and raw scorecard/run identities from text."""

    message = _ANONYMOUS_KEY_LOG.sub(r"\1<redacted>", str(value))
    message = _SCORECARD_API_PATH_LOG.sub(r"\1<redacted>", message)
    message = _RECORDING_PATH_LOG.sub(r"\1<redacted>", message)
    message = _ARC_IDENTIFIER_LOG.sub(r"\1<redacted>", message)
    return _ARC_GUID_WORD_LOG.sub(r"\1<redacted>", message)


class _RedactArcSecrets(logging.Filter):
    """Remove server-issued ARC credentials and run IDs from SDK log records."""

    def filter(self, record: logging.LogRecord) -> bool:
        original = record.getMessage()
        message = redact_arc_private_material(original)
        if message != original:
            record.msg = message
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
    print(
        json.dumps({"ok": False, "error": redact_arc_private_material(message)}),
        flush=True,
    )


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


def total_levels_or_none(value: Any) -> int | None:
    for name in ("total_levels", "level_count", "win_levels"):
        candidate = getattr(value, name, None)
        if candidate is None or candidate == 0:
            continue
        if isinstance(candidate, bool) or not isinstance(candidate, int) or candidate < 0:
            raise ValueError(f"{name} must be a non-negative integer")
        return candidate
    return None


def serialize_frame(raw: Any) -> dict[str, Any]:
    return {
        "game_id": getattr(raw, "game_id", None),
        "frame": jsonable(getattr(raw, "frame", [])),
        "state": jsonable(getattr(raw, "state", "UNKNOWN")),
        "levels_completed": int(getattr(raw, "levels_completed", 0) or 0),
        "total_levels": total_levels_or_none(raw),
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
        "total_levels": total_levels_or_none(item),
    }


def environment_list(arcade: Any) -> list[dict[str, Any]]:
    return [serialize_environment_info(item) for item in arcade.get_environments()]


def resolve_environment_key(request: dict, open_environments: dict) -> str:
    handle = str(request.get("handle") or "").strip()
    if handle:
        if handle not in open_environments:
            raise ValueError(f"No environment is open for handle: {handle}")
        return handle
    if "default" not in open_environments:
        raise ValueError("No game is open")
    return "default"


def resolve_environment(request: dict, open_environments: dict):
    return open_environments[resolve_environment_key(request, open_environments)][0]


def is_episode_terminal(state: Any) -> bool:
    return str(state or "").strip().upper() in {"WIN", "GAME_OVER", "ERROR"}


def new_lifecycle(state: Any) -> dict[str, Any]:
    return {
        "state": str(state or "UNKNOWN"),
        "gameplay_actions_forwarded": 0,
        "post_terminal_gameplay_actions": 0,
    }


def forward_gameplay(
    target: Any,
    action: Any,
    data: dict,
    reasoning: dict | None,
    lifecycle: dict[str, Any],
):
    """Instrument the single production seam immediately before env.step."""

    lifecycle["gameplay_actions_forwarded"] += 1
    if is_episode_terminal(lifecycle.get("state")):
        lifecycle["post_terminal_gameplay_actions"] += 1
    return target.step(action, data=data, reasoning=reasoning)


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
        session_started_at = datetime.now(timezone.utc).isoformat()
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
        open_environments: dict[str, tuple[Any, str]] = {}
        environment_lifecycles: dict[str, dict[str, Any]] = {}
        current_game_id = None
        if args.game:
            initial_env = arcade.make(args.game)
            if initial_env is None:
                fail(f"Could not create ARC environment: {args.game}")
                return 3
            open_environments["default"] = (initial_env, args.game)
            environment_lifecycles["default"] = new_lifecycle(
                serialize_frame(initial_env.observation_space)["state"]
            )
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
                handle = str(request.get("handle") or "").strip()
                env = arcade.make(requested_game)
                if env is None:
                    raise ValueError(f"Could not create ARC environment: {requested_game}")
                # One Arcade session may own several environments at once;
                # the cumulative scorecard keeps official semantics while the
                # host runs games concurrently through handles. Handle-less
                # opens keep the single-environment contract via "default".
                open_environments[handle or "default"] = (env, requested_game)
                frame = serialize_frame(env.observation_space)
                environment_lifecycles[handle or "default"] = new_lifecycle(frame["state"])
                current_game_id = requested_game
                response = {
                    "ok": True,
                    "game_id": requested_game,
                    "handle": handle or None,
                    "frame": frame,
                }
            elif command == "observe":
                key = resolve_environment_key(request, open_environments)
                target = resolve_environment(request, open_environments)
                frame = serialize_frame(target.observation_space)
                environment_lifecycles[key]["state"] = str(frame["state"])
                response = {"ok": True, "frame": frame}
            elif command in ("step", "reset"):
                key = resolve_environment_key(request, open_environments)
                target = resolve_environment(request, open_environments)
                lifecycle = environment_lifecycles[key]
                if command == "step" and is_episode_terminal(lifecycle.get("state")):
                    raise ValueError(
                        "EPISODE_TERMINAL: gameplay step rejected; use reset or finish"
                    )
                action_name = "RESET" if command == "reset" else request.get("action")
                action = resolve_action(GameAction, action_name)
                data = request.get("data") or {}
                if hasattr(action, "set_data"):
                    action.set_data(data)
                reasoning = request.get("reasoning")
                if reasoning is not None and not isinstance(reasoning, dict):
                    reasoning = {"text": str(reasoning)}
                raw = (
                    forward_gameplay(target, action, data, reasoning, lifecycle)
                    if command == "step"
                    else target.step(action, data=data, reasoning=reasoning)
                )
                frame = serialize_frame(raw)
                lifecycle["state"] = str(frame["state"])
                response = {"ok": True, "frame": frame}
            elif command == "lifecycle":
                key = resolve_environment_key(request, open_environments)
                lifecycle = environment_lifecycles[key]
                response = {
                    "ok": True,
                    "lifecycle": {
                        "state": lifecycle["state"],
                        "gameplay_actions_forwarded": lifecycle[
                            "gameplay_actions_forwarded"
                        ],
                        "post_terminal_gameplay_actions": lifecycle[
                            "post_terminal_gameplay_actions"
                        ],
                    },
                }
            elif command == "scorecard":
                scorecard = arcade.get_scorecard()
                scorecard_observed_at = datetime.now(timezone.utc)
                response = {
                    "ok": True,
                    "arc_auth": auth,
                    "scorecard": jsonable(scorecard),
                    "scorecard_session": {
                        "started_at": jsonable(
                            getattr(scorecard, "open_at", session_started_at)
                        ),
                        "observed_at": jsonable(scorecard_observed_at),
                    },
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
