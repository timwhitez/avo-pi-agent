#!/usr/bin/env python3
"""Line-delimited JSON bridge between Node/Pi and the official arc-agi runtime.

The bridge deliberately exposes only environment discovery, game selection,
observation, step/reset, and scorecard operations. Provider credentials never
enter this process. One bridge process owns one Arcade instance so a full
public-suite run produces a cumulative scorecard.
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, is_dataclass
from enum import Enum
from typing import Any


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


def environment_list(arcade: Any) -> list[dict[str, Any]]:
    return [
        {
            "game_id": getattr(item, "game_id", None),
            "title": getattr(item, "title", None),
        }
        for item in arcade.get_environments()
    ]


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
        import arc_agi
        from arc_agi import OperationMode
        from arcengine import GameAction
    except Exception as exc:
        fail(
            "Official ARC runtime unavailable. Use Python 3.12 and run "
            f"scripts/setup-arc.sh. Import error: {exc}"
        )
        return 2

    try:
        arcade = arc_agi.Arcade(operation_mode=OperationMode.NORMAL)
        if args.list:
            print(json.dumps({
                "ok": True,
                "environments": environment_list(arcade),
            }), flush=True)
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
                response = {"ok": True, "environments": environment_list(arcade)}
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
                response = {"ok": True, "scorecard": jsonable(arcade.get_scorecard())}
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
