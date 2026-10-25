"""Sending a run to Telmoni through the SDK, and reading from its warnings whether the
run arrived, was refused for good, or should be sent again."""

from __future__ import annotations

import logging
import math
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .log import Log
from .record import spans
from .settings import Settings

# The SDK sends 512-span batches one at a time, each at worst three attempts of ten
# seconds with two minutes of Retry-After between: a flush waits that out, and slack.
BATCH = 512
BATCH_WORST_S = 150
FLUSH_SLACK_S = 30
UNDELIVERED = ("export failed after", "an export failed (", "the export queue was full")
PARTIAL = ("the server dropped", "the server refused a span", "past the 1 MiB", "the server said")
# Refused for what the run holds, for the organization's standing, or for a fault of
# Telmoni's own that a second try would meet again.
FINAL_STATUSES = (400, 402, 413, 500)
DATABASE_FAILED = "/errors/internal/database"


@dataclass(frozen=True)
class Verdict:
    outcome: str  # sent | partial | refused | undelivered
    detail: str = ""


def flush_seconds(count: int) -> float:
    return FLUSH_SLACK_S + BATCH_WORST_S * math.ceil(count / BATCH)


def judge(warnings: list[str], flushed: bool) -> Verdict:
    """What the SDK's warnings say happened to the run."""
    for text in warnings:
        if "export refused with" in text:
            status = _status(text)
            if status in FINAL_STATUSES and not (status == 500 and DATABASE_FAILED in text):
                return Verdict("refused", text)
            return Verdict("undelivered", text)
    for text in warnings:
        if any(marker in text for marker in UNDELIVERED):
            return Verdict("undelivered", text)
    if not flushed:
        return Verdict("undelivered", "the flush timed out")
    for text in warnings:
        if any(marker in text for marker in PARTIAL):
            return Verdict("partial", text)
    return Verdict("sent")


def _status(text: str) -> int | None:
    after = text.split("export refused with", 1)[1].strip()
    digits = after[:3]
    return int(digits) if digits.isdigit() else None


class _Warnings(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.WARNING)
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(record.getMessage())


class Sender:
    """One SDK client a run, so each run's warnings are its own."""

    def __init__(
        self,
        settings: Settings,
        log: Log,
        session: str,
        event: str,
        transport: Callable[..., Any] | None = None,
        sleep: Callable[[float], None] | None = None,
    ) -> None:
        self.settings = settings
        self.log = log
        self.session = session
        self.event = event
        self.transport = transport
        self.sleep = sleep

    def send(self, record: dict[str, Any], warned: dict[str, bool]) -> Verdict:
        try:
            import telmoni
        except ImportError:
            if not warned.get("sdk"):
                warned["sdk"] = True
                self.log.line(
                    self.session,
                    self.event,
                    "the telmoni SDK is not installed for python3: install uv, or pip install it",
                )
            return Verdict("undelivered", "no SDK")
        try:
            config = telmoni.Config(
                endpoint=self.settings.endpoint,
                api_key=self.settings.api_key,
                release=record.get("release"),
            )
        except ValueError as refusal:
            # The SDK's own words name at most the host, never the key.
            if not warned.get("endpoint"):
                warned["endpoint"] = True
                self.log.line(self.session, self.event, f"endpoint refused: {refusal}")
            return Verdict("undelivered", "endpoint refused")
        client = telmoni.Telmoni(config, transport=self.transport, sleep=self.sleep)
        heard = _Warnings()
        logger = logging.getLogger("telmoni")
        logger.addHandler(heard)
        try:
            try:
                client.record_run(_to_sdk(telmoni, record))
            except telmoni.QueueFullError:
                return Verdict("refused", "more spans than the SDK's queue holds")
            except (TypeError, ValueError) as fault:
                return Verdict("refused", f"the SDK refused the run: {fault}")
            flushed = client.flush(timeout_s=flush_seconds(spans(record)))
        finally:
            # Whatever happened, the exporter's thread ends with the client, so the worker can exit.
            client.shutdown()
            logger.removeHandler(heard)
        return judge(heard.lines, flushed)


def _to_sdk(telmoni: Any, record: dict[str, Any]) -> Any:
    return telmoni.RunRecord(
        run_id=record["run_id"],
        agent=record["agent"],
        start=_when(record["start"]),
        end=_when(record["end"]),
        session_id=record.get("session_id"),
        tags=record.get("tags") or None,
        inside=[_call(telmoni, call) for call in record["calls"]],
        error_type=record.get("error_type"),
        cancelled=bool(record.get("cancelled")),
    )


def _call(telmoni: Any, call: dict[str, Any]) -> Any:
    if call["kind"] == "model":
        usage = call.get("usage")
        return telmoni.ModelCallRecord(
            model=call["model"],
            start=_when(call["start"]),
            end=_when(call["end"]),
            provider="anthropic",
            usage=None
            if usage is None
            else telmoni.Usage(
                input_tokens=usage.get("input"),
                output_tokens=usage.get("output"),
                cache_read_input_tokens=usage.get("cache_read"),
                cache_write_input_tokens=usage.get("cache_write"),
            ),
            error_type=call.get("error_type"),
        )
    if call["kind"] == "step":
        return telmoni.StepRecord(
            name=call["name"],
            start=_when(call["start"]),
            end=_when(call["end"]),
            calls=[_call(telmoni, inner) for inner in call.get("calls", ())],
            error_type=call.get("error_type"),
            cancelled=bool(call.get("cancelled")),
        )
    return telmoni.ToolCallRecord(
        name=call["name"],
        start=_when(call["start"]),
        end=_when(call["end"]),
        error_type=call.get("error_type"),
        cancelled=bool(call.get("cancelled")),
    )


def _when(value: str) -> datetime:
    return datetime.fromisoformat(value)
