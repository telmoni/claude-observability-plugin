"""What the plugin remembers of a session between hooks, and the lock one hook holds
on it while it works."""

from __future__ import annotations

import json
import os
import secrets
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

SENT_KEPT = 500


@dataclass
class State:
    # Where the rows of the first turn not yet sent begin.
    offset: int = 0
    sent: list[str] = field(default_factory=list)
    # Turns Telmoni could not take yet, in order, sent again before any new one.
    pending: list[dict[str, Any]] = field(default_factory=list)
    warned: dict[str, bool] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path) -> State:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return cls()
        if not isinstance(data, dict):
            return cls()
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
        return state

    def save(self, path: Path) -> None:
        self.sent = self.sent[-SENT_KEPT:]
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(asdict(self)), encoding="utf-8")
        temporary.replace(path)

    def mark_sent(self, run_id: str) -> None:
        if run_id not in self.sent:
            self.sent.append(run_id)


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class Lock:
    """One worker a session at a time: the file names its holder, and a holder that
    is gone leaves a lock anyone may take."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.token = f"{os.getpid()}:{secrets.token_hex(8)}"
        self.held = False

    def acquire(self, wait: float | None, poll: float = 0.2) -> bool:
        """Takes the lock, waiting up to `wait` seconds for a live holder, or without
        limit when `wait` is None."""
        deadline = None if wait is None else time.monotonic() + wait
        while True:
            try:
                fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                if not self._holder_alive():
                    self._discard()
                    continue
                if deadline is not None and time.monotonic() >= deadline:
                    return False
                time.sleep(poll)
                continue
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(self.token)
            self.held = True
            return True

    def release(self) -> None:
        if not self.held:
            return
        self.held = False
        try:
            if self.path.read_text(encoding="utf-8") == self.token:
                self.path.unlink()
        except OSError:
            pass

    def _holder_alive(self) -> bool:
        try:
            holder = self.path.read_text(encoding="utf-8")
        except OSError:
            return False
        pid, _, _ = holder.partition(":")
        return pid.isdigit() and pid_alive(int(pid))

    def _discard(self) -> None:
        try:
            self.path.unlink()
        except OSError:
            pass
