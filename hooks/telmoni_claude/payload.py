"""The hook's input: which session, which transcript, which event."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

EVENTS = ("Stop", "StopFailure", "SessionEnd")
ID = re.compile(r"[A-Za-z0-9._-]{1,128}")
# A background task of these kinds can still change the turn it belongs to.
BUSY_KINDS = ("subagent", "workflow", "teammate")


@dataclass(frozen=True)
class Payload:
    session_id: str
    transcript_path: str
    event: str
    error: str | None
    busy: bool

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> Payload:
        return cls(
            session_id=str(data["session_id"]),
            transcript_path=str(data["transcript_path"]),
            event=str(data["event"]),
            error=data.get("error"),
            busy=bool(data.get("busy")),
        )


def parse(raw: str, env: Mapping[str, str]) -> Payload | None:
    """The payload, or None when it is not a turn of Claude Code's to record: Cursor runs
    Claude Code's hooks too and records its own conversations; another event; no session."""
    if env.get("CURSOR_VERSION") or env.get("CURSOR_PROJECT_DIR"):
        return None
    try:
        data = json.loads(raw) if raw.strip() else None
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    if any(key in data for key in ("conversation_id", "generation_id", "cursor_version")):
        return None
    event = data.get("hook_event_name")
    session = data.get("session_id")
    path = data.get("transcript_path")
    if event not in EVENTS or not isinstance(session, str) or not ID.fullmatch(session):
        return None
    if not isinstance(path, str) or not path:
        return None
    error = None
    if event == "StopFailure":
        kind = data.get("error")
        error = kind if isinstance(kind, str) and kind else "unknown"
    tasks = data.get("background_tasks")
    busy = isinstance(tasks, list) and any(
        isinstance(task, dict) and task.get("type") in BUSY_KINDS for task in tasks
    )
    return Payload(session, str(Path(path).expanduser()), event, error, busy)
