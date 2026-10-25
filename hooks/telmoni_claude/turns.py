"""A session's rows gathered into turns: a prompt, the replies, the tool calls and
their results, up to the next prompt. What a run is made of, and nothing said."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

from . import transcript as t
from .transcript import Row, Subagent, Usage


@dataclass
class ModelCall:
    model: str
    start: datetime
    end: datetime
    usage: Usage | None = None
    error_type: str | None = None


@dataclass
class ToolCall:
    tool_use_id: str
    name: str
    start: datetime
    end: datetime | None = None
    error_type: str | None = None
    cancelled: bool = False
    skill: str | None = None
    subagent_type: str | None = None
    # Started in the background: its notice, and the reply to it, close the turn.
    background: bool = False
    notified: bool = False
    replied: bool = False


@dataclass
class Turn:
    offset: int
    prompt_uuid: str
    start: datetime
    end: datetime
    version: str | None = None
    model_calls: list[ModelCall] = field(default_factory=list)
    tool_calls: list[ToolCall] = field(default_factory=list)
    ended_by_interruption: bool = False
    open: bool = True
    next_offset: int = 0
    _models: dict[str, ModelCall] = field(default_factory=dict, repr=False)
    _tools: dict[str, ToolCall] = field(default_factory=dict, repr=False)
    # The calls the last result row answered: a refusal's marker right after names them.
    _answered: list[ToolCall] = field(default_factory=list, repr=False)

    def feed(self, row: Row, last: datetime) -> datetime:
        """Take one row of the turn; gives the time the next row follows from."""
        when = row.timestamp or last
        if row.type == "assistant" and row.role == "assistant":
            self._reply(row, last, when)
            return when
        if row.type == "user":
            results = t.tool_results(row)
            if results:
                self._results(row, results, when)
                return when
            kind = t.interruption(row)
            if kind:
                if kind == "tool":
                    for tool in self._answered:
                        tool.cancelled, tool.error_type = True, None
                self.ended_by_interruption = True
                self._later(when)
                return when
        return last

    def _reply(self, row: Row, last: datetime, when: datetime) -> None:
        key = t.message_id(row) or f"row:{row.offset}"
        call = self._models.get(key)
        if call is None:
            call = ModelCall(t.model(row) or "claude", last, when, t.usage(row))
            self._models[key] = call
            self.model_calls.append(call)
        else:
            call.end = max(call.end, when)
            call.usage = t.usage(row) or call.usage
        kind = t.api_error(row)
        if kind:
            call.error_type = kind
        for use in t.tool_uses(row):
            tool = ToolCall(
                use.tool_use_id,
                use.name,
                when,
                skill=use.skill,
                subagent_type=use.subagent_type,
                background=use.background,
            )
            self._tools[use.tool_use_id] = tool
            self.tool_calls.append(tool)
        self._answered = []
        self.ended_by_interruption = False
        self._later(when)

    def _results(self, row: Row, results: list[t.ToolResult], when: datetime) -> None:
        agent = t.async_agent(row)
        answered = []
        for result in results:
            tool = self._tools.get(result.tool_use_id)
            if tool is None:
                continue
            tool.end = when
            tool.cancelled = result.interrupted
            tool.error_type = "ToolError" if result.is_error and not result.interrupted else None
            if agent is not None:
                tool.background = True
            answered.append(tool)
        self._answered = answered
        self._later(when)

    def _later(self, when: datetime) -> None:
        if when > self.end:
            self.end = when


def assemble(rows: list[Row], session_id: str, end: int) -> list[Turn]:
    """The turns these rows hold, the last left open; a fork's rows copied from
    another session are passed over, that session having recorded them."""
    turns: list[Turn] = []
    current: Turn | None = None
    last = datetime.now(timezone.utc)
    # Every tool call so far: a background task's notice can land in a later turn than its call.
    tools: dict[str, ToolCall] = {}
    for row in rows:
        if row.session_id and row.session_id != session_id:
            continue
        if t.is_prompt(row):
            if current is not None:
                current.open = False
                current.next_offset = row.offset
                turns.append(current)
            when = row.timestamp or last
            current = Turn(row.offset, row.uuid or f"offset:{row.offset}", when, when, row.version)
            last = when
            continue
        if current is not None:
            last = current.feed(row, last)
            tools.update(current._tools)
        _notice(row, tools)
    if current is not None:
        current.next_offset = end
        turns.append(current)
    return turns


def _notice(row: Row, tools: dict[str, ToolCall]) -> None:
    """A task's notice marks the background call it answers; the reply after it, in whatever
    turn, says the session went on."""
    if row.type == "assistant":
        for tool in tools.values():
            if tool.notified:
                tool.replied = True
        return
    named = t.notification_tool_use_id(row)
    if named and named in tools:
        tools[named].notified = True
        tools[named].replied = False


def collect(rows: list[Row]) -> tuple[list[ModelCall], list[ToolCall], datetime | None]:
    """A subagent's whole transcript as one span of work: its calls and when it ended."""
    first = next((row.timestamp for row in rows if row.timestamp), None)
    if first is None:
        return [], [], None
    work = Turn(0, "", first, first)
    last = first
    for row in rows:
        last = work.feed(row, last)
    return work.model_calls, work.tool_calls, work.end


def is_complete(turn: Turn, event: str, busy: bool, subagents: dict[str, Subagent]) -> bool:
    """Whether the turn can still change: a background subagent not yet answered and
    replied to, or not yet finished, keeps it waiting; the session's end sends it as is."""
    if event == "SessionEnd":
        return True
    for tool in turn.tool_calls:
        if tool.background and not (tool.notified and tool.replied):
            return False
        known = subagents.get(tool.tool_use_id)
        if known is not None and known.finished is False:
            return False
    return not (turn.open and busy)


def error_type(turn: Turn, event: str, payload_error: str | None) -> str | None:
    """What ended the turn in error: the last reply's API error, or the failure the hook names."""
    if turn.model_calls and turn.model_calls[-1].error_type:
        return turn.model_calls[-1].error_type
    if turn.open and event == "StopFailure":
        return payload_error or "unknown"
    return None
