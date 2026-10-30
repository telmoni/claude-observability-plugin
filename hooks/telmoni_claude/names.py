"""What a record may call a model, a tool, a skill or a subagent's kind: a plain name within
ingest's caps, never a path, nor text a model wrote in a name's place."""

from __future__ import annotations

import re

MODEL_MAX = 128
_PLAIN_TOOL = re.compile(r"[\w.:@+-]{1,145}", re.ASCII)
_PLAIN_KIND = re.compile(r"[\w.:-]{1,64}", re.ASCII)
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_PATH = re.compile(r"[/\\]|~(?:[/\\]|$)|\.{1,2}[/\\]|[A-Za-z]:[/\\]|file:", re.IGNORECASE)
_WEIGHTS = re.compile(r"[/\\]([^/\\]+\.(?:gguf|ggml|bin|safetensors|llamafile))$", re.IGNORECASE)


def model(value: str) -> str:
    """A model's name cut to ingest's cap; a model file's own name for its path, else `unknown`."""
    name = value.strip()
    weights = _WEIGHTS.search(name)
    if weights:
        return weights.group(1)[:MODEL_MAX]
    if not name or _CONTROL.search(name) or _PATH.match(name):
        return "unknown"
    return name[:MODEL_MAX]


def tool(value: str) -> str:
    """A tool's name as every provider's tools are named; the model writes it, so else `unknown`."""
    return value if _PLAIN_TOOL.fullmatch(value) else "unknown"


def kind(value: object) -> str | None:
    """A skill's name or a subagent's kind, where it is a plain one."""
    return value if isinstance(value, str) and _PLAIN_KIND.fullmatch(value) else None
