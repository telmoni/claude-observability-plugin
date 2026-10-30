"""A turn as the run it is recorded as, in plain values that keep in a file."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from datetime import datetime
from typing import Any

from .transcript import Row, Subagent
from .turns import ModelCall, ToolCall, Turn, collect, error_type

AGENT = "claude-code"
NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "https://telmoni.com/claude-observability-plugin")
TAG_MAX = 256


def run_id(session_id: str, prompt_uuid: str) -> str:
    """One id for a turn however often it is sent, from the session and the prompt."""
    return str(uuid.uuid5(NAMESPACE, f"{session_id}:{prompt_uuid}"))


def build(
    turn: Turn,
    session_id: str,
    event: str,
    payload_error: str | None,
    subagents: dict[str, Subagent],
    read: Callable[[Subagent], list[Row]],
    provider: str = "anthropic",
) -> dict[str, Any]:
    calls: list[dict[str, Any]] = [_model(call, provider) for call in turn.model_calls]
    skills: list[str] = []
    for tool in turn.tool_calls:
        if tool.skill and tool.skill not in skills:
            skills.append(tool.skill)
        known = subagents.get(tool.tool_use_id)
        calls.append(
            _step(tool, known, read, turn.end, provider) if known else _tool(tool, turn.end)
        )
    calls.sort(key=lambda call: call["start"])
    record: dict[str, Any] = {
        "run_id": run_id(session_id, turn.prompt_uuid),
        "agent": AGENT,
        "start": _iso(turn.start),
        "end": _iso(turn.end),
        "session_id": session_id,
        "release": turn.version,
        "tags": {"skills": _skills(skills)} if skills else {},
        "error_type": error_type(turn, event, payload_error),
        "cancelled": turn.ended_by_interruption,
        "calls": calls,
    }
    return record


def _skills(names: list[str]) -> str:
    joined = ",".join(names)
    while len(joined) > TAG_MAX and "," in joined:
        joined = joined.rsplit(",", 1)[0]
    return joined[:TAG_MAX]


def _model(call: ModelCall, provider: str) -> dict[str, Any]:
    usage = call.usage
    return {
        "kind": "model",
        "model": call.model,
        "provider": provider,
        "start": _iso(call.start),
        "end": _iso(max(call.end, call.start)),
        "usage": None
        if usage is None
        else {
            "input": usage.input,
            "output": usage.output,
            "cache_read": usage.cache_read,
            "cache_write": usage.cache_write,
        },
        "error_type": call.error_type,
        "cancelled": call.cancelled,
    }


def _tool(tool: ToolCall, turn_end: datetime) -> dict[str, Any]:
    end = tool.end or turn_end
    return {
        "kind": "tool",
        "name": tool.name,
        "start": _iso(tool.start),
        "end": _iso(max(end, tool.start)),
        "error_type": tool.error_type,
        # A call never answered was stopped with the turn.
        "cancelled": tool.cancelled or tool.end is None,
    }


def _step(
    tool: ToolCall,
    known: Subagent,
    read: Callable[[Subagent], list[Row]],
    turn_end: datetime,
    provider: str,
) -> dict[str, Any]:
    models, tools, ended = collect(read(known))
    end = max(filter(None, (tool.end, ended, tool.start)))
    inner = [_model(call, provider) for call in models] + [_tool(call, end) for call in tools]
    inner.sort(key=lambda call: call["start"])
    kind = tool.subagent_type or known.agent_type
    return {
        "kind": "step",
        "name": f"subagent {kind}" if kind else "subagent",
        "start": _iso(tool.start),
        "end": _iso(max(end, tool.start)),
        "error_type": tool.error_type,
        "cancelled": tool.cancelled or tool.end is None,
        "calls": inner,
    }


def spans(record: dict[str, Any]) -> int:
    """How many spans the run becomes: itself, each call, each step and the calls inside."""
    count = 1
    for call in record["calls"]:
        count += 1 + len(call.get("calls", ()))
    return count


def _iso(when: datetime) -> str:
    return when.isoformat()
