"""The work of one hook, in a process of its own: read what the session wrote since
the last hook, send each turn that has ended, remember the rest."""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from . import record as records
from . import transcript, turns
from .log import Log
from .payload import Payload
from .send import Sender, Verdict
from .settings import Settings
from .state import Lock, State

# A Stop waits this long for another hook on the session; the session's end waits it out.
STOP_WAIT_S = 60.0
SETTLE_QUIET_S = 0.5
SETTLE_LIMIT_S = 3.0


def run(
    payload: Mapping[str, Any],
    env: Mapping[str, str],
    transport: Callable[..., Any] | None = None,
    sleep: Callable[[float], None] | None = None,
) -> int:
    given = Payload.from_dict(payload)
    try:
        settings = Settings.read(env)
    except OSError:
        return 0
    log = Log(settings.state_dir / "hook.log")
    try:
        _run(given, settings, log, transport, sleep)
    except Exception as fault:  # noqa: BLE001 - a hook never fails the session
        log.line(given.session_id, given.event, f"failed: {type(fault).__name__}")
    return 0


def _run(
    given: Payload,
    settings: Settings,
    log: Log,
    transport: Callable[..., Any] | None,
    sleep: Callable[[float], None] | None,
) -> None:
    session, event = given.session_id, given.event
    state_path = settings.state_dir / f"{session}.json"
    state = State.load(state_path)
    if not settings.api_key:
        if not state.warned.get("key"):
            state.warned["key"] = True
            state.save(state_path)
            log.line(
                session,
                event,
                "no key: set TELMONI_API_KEY as a plugin setting or in the environment",
            )
        return
    lock = Lock(settings.state_dir / f"{session}.lock")
    if not lock.acquire(None if event == "SessionEnd" else STOP_WAIT_S):
        log.line(session, event, "another hook holds the session; the next hook sends")
        return
    try:
        state = State.load(state_path)
        path = Path(given.transcript_path)
        if not path.is_file():
            log.line(session, event, "no transcript at the path given")
            return
        _settle(path)
        read = transcript.read_rows(path, state.offset)
        if read.restarted:
            state.offset = 0
        subagents = transcript.discover_subagents(path)
        found = turns.assemble(read.rows, session, read.end)
        sender = Sender(settings, log, session, event, transport, sleep)
        _deliver(state, found, sender, given, subagents, log)
        state.save(state_path)
    finally:
        lock.release()


def _deliver(
    state: State,
    found: list[turns.Turn],
    sender: Sender,
    given: Payload,
    subagents: dict[str, transcript.Subagent],
    log: Log,
) -> None:
    session, event = given.session_id, given.event
    # What Telmoni could not take before goes first, and holds what follows.
    while state.pending:
        verdict = sender.send(state.pending[0], state.warned)
        _note(log, session, event, state.pending[0], verdict)
        if verdict.outcome == "undelivered":
            break
        state.mark_sent(state.pending.pop(0)["run_id"])
    offset = state.offset
    for turn in found:
        run_id = records.run_id(session, turn.prompt_uuid)
        if run_id in state.sent:
            offset = turn.next_offset
            continue
        if not turns.is_complete(turn, event, given.busy, subagents):
            break
        if not turn.model_calls and not turn.tool_calls:
            offset = turn.next_offset
            continue
        made = records.build(turn, session, event, given.error, subagents, _read_subagent)
        if state.pending:
            state.pending.append(made)
        else:
            verdict = sender.send(made, state.warned)
            _note(log, session, event, made, verdict)
            if verdict.outcome == "undelivered":
                state.pending.append(made)
            else:
                state.mark_sent(run_id)
        offset = turn.next_offset
    state.offset = offset


def _read_subagent(known: transcript.Subagent) -> list[transcript.Row]:
    try:
        return transcript.read_rows(known.path, 0).rows
    except OSError:
        return []


def _note(log: Log, session: str, event: str, made: dict[str, Any], verdict: Verdict) -> None:
    run_id = made["run_id"][:8]
    if verdict.outcome == "sent":
        log.line(session, event, f"sent {run_id}")
    elif verdict.outcome == "partial":
        log.line(session, event, f"taken in part {run_id}: {verdict.detail}")
    elif verdict.outcome == "refused":
        log.line(session, event, f"refused, not sent again {run_id}: {verdict.detail}")
    else:
        log.line(
            session, event, f"not delivered {run_id}, sent again at the next hook: {verdict.detail}"
        )


def _settle(path: Path) -> None:
    """Waits for the transcript to stop growing: a hook can run before its last rows land."""
    deadline = time.monotonic() + SETTLE_LIMIT_S
    seen = _mark(path)
    quiet_since = time.monotonic()
    while time.monotonic() < deadline:
        time.sleep(0.1)
        now = _mark(path)
        if now != seen:
            seen, quiet_since = now, time.monotonic()
        elif time.monotonic() - quiet_since >= SETTLE_QUIET_S:
            return


def _mark(path: Path) -> tuple[int, int]:
    try:
        stat = path.stat()
    except OSError:
        return (-1, -1)
    return (stat.st_size, stat.st_mtime_ns)
