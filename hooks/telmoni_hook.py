#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "telmoni>=0.2,<1",
# ]
# ///
"""Claude Code's hook: reads the event, hands the session to a worker of its own and
returns at once, so no turn and no exit waits on Telmoni. `--work` is that worker."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from telmoni_claude import payload as hook_payload  # noqa: E402
from telmoni_claude import settings, worker  # noqa: E402


def main(argv: list[str]) -> int:
    if len(argv) >= 3 and argv[1] == "--work":
        return worker.run(json.loads(argv[2]), os.environ)
    given = hook_payload.parse(sys.stdin.read(), os.environ)
    if given is None:
        return 0
    # The tests run the worker in this process; a session runs it detached.
    if os.environ.get("TELMONI_HOOK_INLINE") == "1":
        return worker.run(given.as_dict(), os.environ)
    log_path = settings.state_dir(os.environ) / "hook.log"
    with log_path.open("ab") as log:
        subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--work", json.dumps(given.as_dict())],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=log,
            start_new_session=True,
            close_fds=True,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
