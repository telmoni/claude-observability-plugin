#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Claude Code's hook: reads the event, hands the session to a worker of its own and
returns at once, so no turn and no exit waits on Telmoni. It needs no dependency, so uv
fetches nothing before it runs; the worker, `telmoni_worker.py`, carries the SDK."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from telmoni_claude import payload as hook_payload  # noqa: E402
from telmoni_claude import settings, worker  # noqa: E402

# Windows has no session to start the worker in: these flags detach it instead.
DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200


def main(argv: list[str]) -> int:
    try:
        given = hook_payload.parse(sys.stdin.read(), os.environ)
        if given is None:
            return 0
        # The tests run the worker in this process; a session runs it detached.
        if os.environ.get("TELMONI_HOOK_INLINE") == "1":
            return worker.run(given.as_dict(), os.environ)
        _start(given.as_dict())
    except Exception:  # noqa: BLE001 - a hook never fails the session, even with nowhere to log
        pass
    return 0


def _start(payload: dict[str, Any]) -> None:
    detached: dict[str, Any] = (
        {"creationflags": DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP}
        if sys.platform == "win32"
        else {"start_new_session": True}
    )
    log_path = settings.state_dir(os.environ) / "hook.log"
    worker_path = str(Path(__file__).resolve().with_name("telmoni_worker.py"))
    uv = shutil.which("uv")
    # Through uv where it is: the worker's header names the SDK, fetched there, detached.
    if uv:
        command = [uv, "run", "--quiet", "--script", worker_path]
    else:
        command = [sys.executable, worker_path]
    fd = os.open(log_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(fd, "ab") as log:
        child = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=log,
            close_fds=True,
            **detached,
        )
    # By its stdin, not its argv: ps shows argv to everyone, and the payload names the transcript.
    child.stdin.write(json.dumps(payload).encode("utf-8"))
    child.stdin.close()


if __name__ == "__main__":
    sys.exit(main(sys.argv))
