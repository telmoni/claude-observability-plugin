"""Reading a session's transcript: its rows from a byte offset, and of each row only
its kind, ids, times, counts and flags. A prompt's first characters are read for the
markers Claude Code writes there, and never kept."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

INTERRUPTED = "[Request interrupted by user"
INTERRUPTED_TOOL = "[Request interrupted by user for tool use]"
NOTIFICATION = "<task-notification>"
NOT_A_PROMPT = ("<local-command-stdout>", "<local-command-caveat>", "<system-reminder>")
HEAD = 64
# Rows Claude Code writes in the person's place: injected context, a compaction's
# summary, its own nudges, a subagent's side of the conversation.
NOT_A_PERSONS = ("isMeta", "isCompactSummary", "turnCompanion", "isSidechain")


@dataclass(frozen=True)
class Row:
    offset: int
    data: dict[str, Any]

    @property
    def type(self) -> str | None:
        kind = self.data.get("type")
        return kind if isinstance(kind, str) else None

    @property
    def message(self) -> dict[str, Any] | None:
        message = self.data.get("message")
        return message if isinstance(message, dict) else None

    @property
    def role(self) -> str | None:
        message = self.message
        role = message.get("role") if message else None
        return role if isinstance(role, str) else None

    @property
    def timestamp(self) -> datetime | None:
        return parse_timestamp(self.data.get("timestamp"))

    @property
    def uuid(self) -> str | None:
        value = self.data.get("uuid")
        return value if isinstance(value, str) and value else None

    @property
    def session_id(self) -> str | None:
        value = self.data.get("sessionId")
        return value if isinstance(value, str) and value else None

    @property
    def version(self) -> str | None:
        value = self.data.get("version")
        return value if isinstance(value, str) and value else None


@dataclass(frozen=True)
class Read:
    rows: list[Row]
    end: int
    restarted: bool


def read_rows(path: Path, start: int) -> Read:
    """The whole rows from byte `start`, each with its offset, and where the next read
    begins; a file shorter than `start` was replaced, and is read from its beginning."""
    size = path.stat().st_size
    restarted = size < start
    if restarted:
        start = 0
    with path.open("rb") as f:
        f.seek(start)
        chunk = f.read()
    rows: list[Row] = []
    position = start
    lines = chunk.split(b"\n")
    for line in lines[:-1]:
        offset = position
        position += len(line) + 1
        if not line.strip():
            continue
        try:
            data = json.loads(line)
        except ValueError:
            continue
        if isinstance(data, dict):
            rows.append(Row(offset, data))
    return Read(rows, position, restarted)


def parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _text(row: Row) -> str:
    message = row.message
    content = message.get("content") if message else None
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        # The first text block that says anything: an image comes behind an empty one.
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text")
                if isinstance(text, str) and text.strip():
                    return text
    return ""


def _block_types(row: Row) -> set[str]:
    message = row.message
    content = message.get("content") if message else None
    if not isinstance(content, list):
        return set()
    kinds = (block.get("type") for block in content if isinstance(block, dict))
    return {kind for kind in kinds if isinstance(kind, str)}


def origin_kind(row: Row) -> str | None:
    """Where Claude Code says a user row came from: the person, a task's notice, a peer."""
    origin = row.data.get("origin")
    kind = origin.get("kind") if isinstance(origin, dict) else None
    return kind if isinstance(kind, str) else None


def head(row: Row) -> str:
    """The first characters of what a user row says, for its markers alone."""
    return _text(row).lstrip()[:HEAD]


@dataclass(frozen=True)
class ToolResult:
    tool_use_id: str
    is_error: bool
    interrupted: bool


def tool_results(row: Row) -> list[ToolResult]:
    message = row.message
    content = message.get("content") if message else None
    if not isinstance(content, list):
        return []
    tool_use = row.data.get("toolUseResult")
    interrupted = isinstance(tool_use, dict) and tool_use.get("interrupted") is True
    results = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "tool_result":
            tool_use_id = block.get("tool_use_id")
            if isinstance(tool_use_id, str) and tool_use_id:
                results.append(ToolResult(tool_use_id, block.get("is_error") is True, interrupted))
    return results


def is_prompt(row: Row) -> bool:
    """A prompt the person gave: not Claude Code's own rows, its injected context, a
    compaction's summary, a tool's result, a task's notice or an interruption. An image
    alone is one, known by the row's origin or by the image."""
    if row.type != "user" or row.role != "user":
        return False
    data = row.data
    if any(data.get(flag) for flag in NOT_A_PERSONS):
        return False
    if tool_results(row):
        return False
    first = head(row)
    if first.startswith((INTERRUPTED, NOTIFICATION, *NOT_A_PROMPT)):
        return False
    return bool(first) or origin_kind(row) == "human" or "image" in _block_types(row)


def interruption(row: Row) -> str | None:
    """`tool` for a denied tool call, `turn` for a stopped turn, else None."""
    if row.type != "user" or row.role != "user":
        return None
    first = head(row)
    if first.startswith(INTERRUPTED_TOOL):
        return "tool"
    if first.startswith(INTERRUPTED):
        return "turn"
    return None


def notification_tool_use_id(row: Row) -> str | None:
    """The tool call a background task's notice answers, read off its tags."""
    if row.type != "user":
        return None
    if origin_kind(row) != "task-notification" and not head(row).startswith(NOTIFICATION):
        return None
    text = _text(row)
    start = text.find("<tool-use-id>")
    end = text.find("</tool-use-id>", start + 13) if start >= 0 else -1
    if start < 0 or end < 0:
        return None
    tool_use_id = text[start + 13 : end].strip()
    return tool_use_id or None


def async_agent(row: Row) -> str | None:
    """The id of a subagent a tool result says runs in the background, else None."""
    tool_use = row.data.get("toolUseResult")
    if not isinstance(tool_use, dict):
        return None
    launched = tool_use.get("status") in ("async_launched", "teammate_spawned")
    if not launched and tool_use.get("isAsync") is not True:
        return None
    agent_id = tool_use.get("agentId")
    return agent_id if isinstance(agent_id, str) else ""


def message_id(row: Row) -> str | None:
    message = row.message
    value = message.get("id") if message else None
    return value if isinstance(value, str) and value else None


def model(row: Row) -> str | None:
    message = row.message
    value = message.get("model") if message else None
    return value if isinstance(value, str) and value else None


@dataclass(frozen=True)
class Usage:
    input: int | None
    output: int | None
    cache_read: int | None
    cache_write: int | None


def usage(row: Row) -> Usage | None:
    message = row.message
    raw = message.get("usage") if message else None
    if not isinstance(raw, dict):
        return None
    write = None
    split = raw.get("cache_creation")
    if isinstance(split, dict):
        parts = [v for v in split.values() if isinstance(v, int) and v >= 0]
        write = sum(parts) if parts else None
    if write is None:
        write = _count(raw.get("cache_creation_input_tokens"))
    # Anthropic leaves the cache out of `input_tokens`; the conventions' input holds it.
    uncached = _count(raw.get("input_tokens"))
    read = _count(raw.get("cache_read_input_tokens"))
    counted = [n for n in (uncached, read, write) if n is not None]
    return Usage(
        input=sum(counted) if counted else None,
        output=_count(raw.get("output_tokens")),
        cache_read=read,
        cache_write=write,
    )


def _count(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def api_error(row: Row) -> str | None:
    """The kind of API error a reply row carries (`rate_limit`), never its message."""
    if row.data.get("isApiErrorMessage") is not True:
        return None
    kind = row.data.get("error")
    if isinstance(kind, str) and 0 < len(kind) <= 64 and " " not in kind:
        return kind
    return "ApiError"


@dataclass(frozen=True)
class ToolUse:
    tool_use_id: str
    name: str
    skill: str | None
    subagent_type: str | None
    background: bool


def tool_uses(row: Row) -> list[ToolUse]:
    """Each tool call a reply row makes: its id and name, a skill's name, a subagent's kind."""
    message = row.message
    content = message.get("content") if message else None
    if not isinstance(content, list):
        return []
    uses = []
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            continue
        tool_use_id, name = block.get("id"), block.get("name")
        if not isinstance(tool_use_id, str) or not tool_use_id or not isinstance(name, str):
            continue
        given = block.get("input") if isinstance(block.get("input"), dict) else {}
        skill = given.get("skill") if name == "Skill" else None
        kind = given.get("subagent_type") if name in ("Agent", "Task") else None
        uses.append(
            ToolUse(
                tool_use_id,
                name,
                skill if isinstance(skill, str) and skill else None,
                kind if isinstance(kind, str) and kind else None,
                name in ("Agent", "Task") and given.get("run_in_background") is True,
            )
        )
    return uses


@dataclass(frozen=True)
class Subagent:
    tool_use_id: str
    agent_type: str | None
    finished: bool | None
    path: Path


def subagents_dir(transcript_path: Path) -> Path:
    return transcript_path.with_suffix("") / "subagents"


def discover_subagents(transcript_path: Path) -> dict[str, Subagent]:
    """The session's subagent transcripts by the tool call that started each."""
    folder = subagents_dir(transcript_path)
    if not folder.is_dir():
        return {}
    found: dict[str, Subagent] = {}
    for meta_path in sorted(folder.rglob("*.meta.json")):
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        tool_use_id = meta.get("toolUseId") if isinstance(meta, dict) else None
        if not isinstance(tool_use_id, str) or not tool_use_id:
            continue
        rows_path = meta_path.with_name(meta_path.name[: -len(".meta.json")] + ".jsonl")
        if not rows_path.exists():
            continue
        agent_type = meta.get("agentType")
        finished = meta.get("finished")
        found[tool_use_id] = Subagent(
            tool_use_id,
            agent_type if isinstance(agent_type, str) and agent_type else None,
            finished if isinstance(finished, bool) else None,
            rows_path,
        )
    return found
