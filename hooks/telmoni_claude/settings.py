"""The plugin's settings and where it keeps its state."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

DEFAULT_ENDPOINT = "https://api.telmoni.com"


def option(name: str, env: Mapping[str, str]) -> str:
    """A setting: the plugin's own first, then the environment's; blank is unset."""
    own = (env.get(f"CLAUDE_PLUGIN_OPTION_{name}") or "").strip()
    return own or (env.get(name) or "").strip()


def state_dir(env: Mapping[str, str]) -> Path:
    """Where the state, the locks and the log live: the folder Claude Code keeps for the
    plugin across its updates, else `telmoni` under its config folder."""
    data = env.get("CLAUDE_PLUGIN_DATA")
    if data and Path(data).is_absolute():
        made = _usable(Path(data))
        if made is not None:
            return made
    home = Path(env.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
    made = _usable(home / "telmoni")
    if made is None:
        raise OSError(f"no writable state folder under {home}")
    return made


def _usable(path: Path) -> Path | None:
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None
    return path if os.access(path, os.W_OK | os.X_OK) else None


@dataclass(frozen=True)
class Settings:
    api_key: str | None
    endpoint: str
    state_dir: Path

    @classmethod
    def read(cls, env: Mapping[str, str]) -> Settings:
        return cls(
            api_key=option("TELMONI_API_KEY", env) or None,
            endpoint=option("TELMONI_ENDPOINT", env) or DEFAULT_ENDPOINT,
            state_dir=state_dir(env),
        )
