"""The work of one hook, in a process of its own: read what the session wrote since
the last hook, send each turn that has ended, remember the rest."""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from . import record as records
from . import state as states
from . import transcript, turns
from .log import Log
from .payload import Payload
from .send import Outcome, Sender, Verdict
from .settings import Settings
from .state import Lock, State

# A Stop waits this long for another hook on the session; the session's end waits it out.
STOP_WAIT_S = 60.0
SETTLE_QUIET_S = 0.5
SETTLE_LIMIT_S = 3.0
# Each run sent is remembered at most this soon after the last: a catch-up may take hours.
SAVE_EVERY_S = 1.0
# A session's lock untouched this long is let go: a session hooks again within days, or not at all.
SWEEP_AFTER_S = 7 * 24 * 3600.0


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
    lock = Lock(settings.state_dir / f"{session}.lock")
    if not lock.acquire(None if event == "SessionEnd" else STOP_WAIT_S):
        log.line(session, event, "another hook holds the session; the next hook sends")
        return
    try:
        try:
            state = State.load(state_path)
        except (OSError, ValueError) as fault:
            # Left as it is: read as new, it would send the session again and lose its kept runs.
            log.line(session, event, f"state not read ({type(fault).__name__}); nothing sent")
            return
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
        state.destination = settings.destination()
        saver = _Saver(state, state_path)
        try:
            _deliver(state, found, sender, given, subagents, log, saver)
        finally:
            saver.save()
        reached = not state.pending
    finally:
        lock.release()
    if reached:
        _send_left(settings, log, session, event, transport, sleep)
    _sweep_locks(settings, session)


def _sweep_locks(settings: Settings, own: str) -> None:
    """Lock files of other sessions gone quiet, judged by their state's last save; a state stays,
    since read as missing it would send a resumed session from its start, and it keeps no
    transcript's path to judge it by."""
    now = time.time()
    for path in settings.state_dir.glob("*.lock"):
        if path.stem == own:
            continue
        last = max(_mtime(path), _mtime(path.with_suffix(".json")))
        if now - last <= SWEEP_AFTER_S:
            continue
        lock = Lock(path)
        if not lock.acquire(0):
            continue
        try:
            # Unlinked while held: a hook that locks the old file after sees it gone, and retries.
            path.unlink(missing_ok=True)
        except OSError:
            pass  # Windows deletes no file held open
        finally:
            lock.release()


def _send_left(
    settings: Settings,
    log: Log,
    own: str,
    event: str,
    transport: Callable[..., Any] | None,
    sleep: Callable[[float], None] | None,
) -> None:
    """Other sessions' kept runs, the longest waiting first, each where its own session's key
    sends alone: their last hook may have met no Telmoni."""
    destination = settings.destination()
    markers = sorted(settings.state_dir.glob("*.pending"), key=_mtime)
    for marker in markers:
        session = marker.stem
        if session == own:
            continue
        lock = Lock(settings.state_dir / f"{session}.lock")
        if not lock.acquire(0):
            continue
        try:
            path = settings.state_dir / f"{session}.json"
            try:
                state = State.load(path)
            except (OSError, ValueError):
                continue
            # Another key, or another endpoint: that session's own next hook sends them.
            if state.destination != destination:
                continue
            sender = Sender(settings, log, session, event, transport, sleep)
            saver = _Saver(state, path)
            try:
                emptied = _send_pending(state, sender, log, session, event, saver)
            finally:
                saver.save()
        finally:
            lock.release()
        if not emptied:
            return  # Telmoni is away again: the next hook of any session tries again


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


class _Saver:
    """Saves the state as each run goes, at most once in `SAVE_EVERY_S`, and whenever asked."""

    def __init__(self, state: State, path: Path) -> None:
        self.state = state
        self.path = path
        self.last = time.monotonic()

    def __call__(self) -> None:
        if time.monotonic() - self.last >= SAVE_EVERY_S:
            self.save()

    def save(self) -> None:
        self.state.save(self.path)
        self.last = time.monotonic()


def _deliver(
    state: State,
    found: list[turns.Turn],
    sender: Sender,
    given: Payload,
    subagents: dict[str, transcript.Subagent],
    log: Log,
    saved: Callable[[], None],
) -> None:
    session, event = given.session_id, given.event
    # What Telmoni could not take before goes first, and holds what follows.
    _send_pending(state, sender, log, session, event, saved)
    for turn in found:
        run_id = records.run_id(session, turn.prompt_uuid)
        if run_id in state.sent:
            state.offset = turn.next_offset
            continue
        if not turns.is_complete(turn, event, given.busy, subagents):
            log.line(session, event, f"held {run_id[:8]}: its turn is not over yet")
            break
        if not turn.model_calls and not turn.tool_calls:
            state.offset = turn.next_offset
            continue
        made = records.build(
            turn,
            session,
            event,
            given.error,
            subagents,
            _read_subagent,
            sender.settings.provider,
        )
        if state.pending:
            state.pending.append(made)
        else:
            verdict = sender.send(made, state.warned)
            _note(log, session, event, made, verdict)
            if verdict.outcome is Outcome.UNDELIVERED:
                state.pending.append(made)
            else:
                state.mark_sent(run_id)
        state.offset = turn.next_offset
        saved()
    dropped = state.trim_pending()
    if dropped:
        log.line(
            session,
            event,
            f"dropped {dropped} runs Telmoni could not take, the newest {states.PENDING_KEPT} kept",
        )


def _send_pending(
    state: State, sender: Sender, log: Log, session: str, event: str, saved: Callable[[], None]
) -> bool:
    """The kept runs, in order, until one is still not delivered; whether none is left."""
    while state.pending:
        verdict = sender.send(state.pending[0], state.warned)
        _note(log, session, event, state.pending[0], verdict)
        if verdict.outcome is Outcome.UNDELIVERED:
            return False
        gone = state.pending.pop(0).get("run_id")
        if isinstance(gone, str):
            state.mark_sent(gone)
        saved()
    return True


def _read_subagent(known: transcript.Subagent) -> list[transcript.Row]:
    try:
        return transcript.read_rows(known.path, 0).rows
    except OSError:
        return []


def _note(log: Log, session: str, event: str, made: dict[str, Any], verdict: Verdict) -> None:
    run_id = str(made.get("run_id"))[:8]
    if verdict.outcome is Outcome.SENT:
        log.line(session, event, f"sent {run_id}")
    elif verdict.outcome is Outcome.PARTIAL:
        log.line(session, event, f"taken in part {run_id}: {verdict.detail}")
    elif verdict.outcome is Outcome.REFUSED:
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
