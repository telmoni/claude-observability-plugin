"""What the plugin remembers of a session between hooks, and the lock one hook holds
on it while it works."""

from __future__ import annotations

import json
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

try:
    import fcntl
except ImportError:  # Windows locks a byte of the file instead
    fcntl = None  # type: ignore[assignment]
    import msvcrt

SENT_KEPT = 500
# Runs kept for a Telmoni that stays away: the newest, so the file stays small and current.
PENDING_KEPT = 200


@dataclass
class State:
    # Where the rows of the first turn not yet sent begin.
    offset: int = 0
    sent: list[str] = field(default_factory=list)
    # Turns Telmoni could not take yet, in order, sent again before any new one.
    pending: list[dict[str, Any]] = field(default_factory=list)
    warned: dict[str, bool] = field(default_factory=dict)
    # Where the session's key sends (`Settings.destination`): its kept runs go there alone.
    destination: str | None = None

    @classmethod
    def load(cls, path: Path) -> State:
        """The session's state, new where none was saved; one that cannot be read raises,
        since read as new it would send the whole session again and lose its kept runs."""
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return cls()
        if not isinstance(data, dict):
            raise ValueError("the state is not an object")
        state = cls()
        offset = data.get("offset")
        if isinstance(offset, int) and offset >= 0:
            state.offset = offset
        sent = data.get("sent")
        if isinstance(sent, list):
            state.sent = [item for item in sent if isinstance(item, str)][-SENT_KEPT:]
        pending = data.get("pending")
        if isinstance(pending, list):
            state.pending = [item for item in pending if isinstance(item, dict)]
        warned = data.get("warned")
        if isinstance(warned, dict):
            state.warned = {key: True for key, value in warned.items() if value is True}
        destination = data.get("destination")
        if isinstance(destination, str):
            state.destination = destination
        return state

    def save(self, path: Path) -> None:
        """Written aside and synced before it replaces the last, so a power cut leaves one whole."""
        self.sent = self.sent[-SENT_KEPT:]
        temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
        with os.fdopen(os.open(temporary, flags, 0o600), "wb") as f:
            f.write(json.dumps(asdict(self)).encode("utf-8"))
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, path)
        # Beside a state still holding runs, so any session's hook finds what is left to send.
        marker = path.with_suffix(".pending")
        if self.pending:
            marker.touch(mode=0o600)
        else:
            marker.unlink(missing_ok=True)

    def mark_sent(self, run_id: str) -> None:
        if run_id not in self.sent:
            self.sent.append(run_id)

    def trim_pending(self) -> int:
        """Lets the oldest pending runs go past the cap; how many went."""
        over = len(self.pending) - PENDING_KEPT
        if over <= 0:
            return 0
        del self.pending[:over]
        return over


class Lock:
    """One worker a session at a time, held through the operating system: a holder that
    dies lets go of it, whatever becomes of its pid, so no stale lock is ever judged."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._fd: int | None = None

    def acquire(self, wait: float | None, poll: float = 0.2) -> bool:
        """Takes the lock, waiting up to `wait` seconds for its holder, or without
        limit when `wait` is None."""
        deadline = None if wait is None else time.monotonic() + wait
        while True:
            fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
            while not _lock(fd):
                if deadline is not None and time.monotonic() >= deadline:
                    os.close(fd)
                    return False
                time.sleep(poll)
            if _linked(fd, self.path):
                self._fd = fd
                return True
            # Swept while this hook waited on it: the lock is the file at the path now.
            _unlock(fd)
            os.close(fd)

    def release(self) -> None:
        fd, self._fd = self._fd, None
        if fd is None:
            return
        # The file stays: removed, a third hook would lock a new one beside a second's.
        _unlock(fd)
        os.close(fd)


def _linked(fd: int, path: Path) -> bool:
    """Whether the file locked is still the one at `path`, which a sweep may have unlinked."""
    if fcntl is None:
        return True  # Windows deletes no file held open, so none is swept under a holder
    try:
        return os.fstat(fd).st_ino == os.stat(path).st_ino
    except OSError:
        return False


def _lock(fd: int) -> bool:
    try:
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        else:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    except OSError:
        return False
    return True


def _unlock(fd: int) -> None:
    try:
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_UN)
        else:
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    except OSError:
        pass
