"""The plugin's log: one line a failure, naming the session by the start of its id and
never anything said in it."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

LIMIT = 1 << 20


class Log:
    def __init__(self, path: Path) -> None:
        self.path = path

    def line(self, session: str, event: str, text: str) -> None:
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        try:
            if self.path.exists() and self.path.stat().st_size > LIMIT:
                self.path.replace(self.path.with_suffix(".log.1"))
            with self.path.open("a", encoding="utf-8") as f:
                f.write(f"{stamp} {session[:8]} {event} {text}\n")
        except OSError:
            pass
