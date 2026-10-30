#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "telmoni>=0.2,<1",
# ]
# ///
"""The worker a hook starts detached, with the SDK in its header: uv fetches it here the
first time, where no Stop waits on it. Its payload comes on stdin."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from telmoni_claude import worker  # noqa: E402


def main() -> int:
    try:
        return worker.run(json.loads(sys.stdin.read()), os.environ)
    except Exception:  # noqa: BLE001 - a worker never fails the session, even with nowhere to log
        return 0


if __name__ == "__main__":
    sys.exit(main())
