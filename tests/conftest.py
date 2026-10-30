"""Transcripts written as Claude Code writes them, a Telmoni that answers as told, and
the worker run in this process."""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from telmoni_claude import worker

T0 = datetime(2026, 10, 25, 3, 0, tzinfo=timezone.utc)
# Words that must never leave the transcript: a test fails on any of them in what is sent or kept.
SECRETS = (
    "PROMPT-TEXT-NEVER-SENT",
    "REPLY-TEXT-NEVER-SENT",
    "TOOL-OUTPUT-NEVER-SENT",
    "/home/someone/secret-project",
    "/secret/path",
    "SUBAGENT-PROMPT-NEVER-SENT",
    "SUBAGENT-DESCRIPTION-NEVER-SENT",
    "COPIED-HISTORY-NEVER-SENT",
    "tm_test_key_never_sent",
    "/data/models/NAME-PATH-NEVER-SENT",
    "NAME-TEXT-NEVER-SENT",
)
KEY = "tm_test_key_never_sent"
ENDPOINT = "http://localhost:1"


class Transcript:
    """One session's transcript, a row a call, timestamps a second apart."""

    def __init__(self, path: Path, session_id: str, version: str = "2.1.310") -> None:
        self.path = path
        self.session_id = session_id
        self.version = version
        self.clock = T0
        self.count = 0
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("", encoding="utf-8")

    def tick(self, seconds: float = 1.0) -> datetime:
        self.clock += timedelta(seconds=seconds)
        return self.clock

    def row(self, kind: str, message: dict[str, Any] | None = None, **extra: Any) -> dict[str, Any]:
        self.count += 1
        data: dict[str, Any] = {
            "type": kind,
            "uuid": f"uuid-{self.count}",
            "sessionId": self.session_id,
            "timestamp": self.clock.isoformat().replace("+00:00", "Z"),
            "version": self.version,
            "isSidechain": False,
            "cwd": "/home/someone/secret-project",
        }
        if message is not None:
            data["message"] = message
        data.update(extra)
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(data) + "\n")
        return data

    def prompt(self, text: str = "PROMPT-TEXT-NEVER-SENT", **extra: Any) -> dict[str, Any]:
        self.tick()
        return self.row("user", {"role": "user", "content": text}, **extra)

    def meta(self, text: str = "<command-name>/compact</command-name>") -> dict[str, Any]:
        self.tick(0.1)
        return self.row("user", {"role": "user", "content": text}, isMeta=True)

    def reply(
        self,
        message_id: str = "msg_1",
        model: str = "claude-opus-5-5",
        tool_uses: tuple[tuple[str, str, dict[str, Any]], ...] = (),
        usage: dict[str, Any] | None = None,
        api_error: str | None = None,
        text: str = "REPLY-TEXT-NEVER-SENT",
    ) -> dict[str, Any]:
        content: list[dict[str, Any]] = [{"type": "text", "text": text}]
        for tool_use_id, name, given in tool_uses:
            content.append({"type": "tool_use", "id": tool_use_id, "name": name, "input": given})
        message = {
            "id": message_id,
            "role": "assistant",
            "model": model,
            "content": content,
            "stop_reason": "tool_use" if tool_uses else "end_turn",
            "usage": usage
            or {
                "input_tokens": 10,
                "output_tokens": 20,
                "cache_read_input_tokens": 5,
                "cache_creation": {"ephemeral_5m_input_tokens": 3, "ephemeral_1h_input_tokens": 0},
            },
        }
        extra: dict[str, Any] = {"requestId": f"req_{message_id}"}
        if api_error:
            extra.update({"isApiErrorMessage": True, "error": api_error, "apiErrorStatus": 429})
        self.tick()
        return self.row("assistant", message, **extra)

    def result(
        self,
        tool_use_id: str,
        is_error: bool = False,
        interrupted: bool = False,
        async_agent: str | None = None,
    ) -> dict[str, Any]:
        block: dict[str, Any] = {
            "type": "tool_result",
            "tool_use_id": tool_use_id,
            "content": "TOOL-OUTPUT-NEVER-SENT",
        }
        if is_error:
            block["is_error"] = True
        tool_use_result: dict[str, Any] = {"stdout": "TOOL-OUTPUT-NEVER-SENT"}
        if interrupted:
            tool_use_result = {"interrupted": True}
        if async_agent:
            tool_use_result = {"status": "async_launched", "isAsync": True, "agentId": async_agent}
        self.tick()
        return self.row("user", {"role": "user", "content": [block]}, toolUseResult=tool_use_result)

    def interrupt(self, tool: bool = False) -> dict[str, Any]:
        text = (
            "[Request interrupted by user for tool use]"
            if tool
            else "[Request interrupted by user]"
        )
        self.tick()
        return self.row("user", {"role": "user", "content": text})

    def image_prompt(self, with_origin: bool = True, caption: bool = False) -> dict[str, Any]:
        """A prompt that is an image: Claude Code writes an empty text block first, and
        marks the row as the person's by its origin."""
        self.tick()
        content: list[dict[str, Any]] = [
            {"type": "text", "text": ""},
            {"type": "image", "source": {"type": "base64", "data": "PROMPT-TEXT-NEVER-SENT"}},
        ]
        if caption:
            content.append({"type": "text", "text": "PROMPT-TEXT-NEVER-SENT"})
        extra = {"origin": {"kind": "human"}} if with_origin else {}
        return self.row("user", {"role": "user", "content": content}, **extra)

    def denied(self, tool_use_id: str) -> dict[str, Any]:
        """A tool call the person refused, as Claude Code writes it: an error result whose
        reason is text, then the marker."""
        block = {
            "type": "tool_result",
            "tool_use_id": tool_use_id,
            "content": "TOOL-OUTPUT-NEVER-SENT",
            "is_error": True,
        }
        self.tick()
        self.row(
            "user", {"role": "user", "content": [block]}, toolUseResult="TOOL-OUTPUT-NEVER-SENT"
        )
        return self.interrupt(tool=True)

    def notice(self, tool_use_id: str) -> dict[str, Any]:
        text = (
            "<task-notification>\n"
            f"<tool-use-id>{tool_use_id}</tool-use-id>\n<status>completed</status>\n"
            "<summary>TOOL-OUTPUT-NEVER-SENT</summary>\n</task-notification>"
        )
        self.tick()
        return self.row("user", {"role": "user", "content": text})

    def companion(self) -> dict[str, Any]:
        self.tick(0.1)
        return self.row(
            "user", {"role": "user", "content": "go on"}, turnCompanion=True, isMeta=True
        )

    def stop_blocked(self) -> dict[str, Any]:
        """A `Stop` hook that blocked, as Claude Code 2.1.312 wrote it: its reason as a meta
        row, the block as an attachment, then the hooks' summary; the turn then goes on."""
        reason = "PROMPT-TEXT-NEVER-SENT"
        self.tick(0.1)
        self.row("user", {"role": "user", "content": f"Stop hook feedback:\n{reason}"}, isMeta=True)
        block = self.row(
            "attachment",
            attachment={
                "type": "hook_blocking_error",
                "hookName": "Stop",
                "toolUseID": "hook-1",
                "hookEvent": "Stop",
                "blockingError": {"blockingError": reason, "command": "/secret/path"},
            },
            renderedRole="system",
        )
        self.row(
            "system",
            subtype="stop_hook_summary",
            hookCount=1,
            hookInfos=[{"command": "/secret/path"}],
            hookErrors=[reason],
            preventedContinuation=False,
            stopReason="",
            level="suggestion",
        )
        return block

    def other_session(self) -> dict[str, Any]:
        self.tick()
        return self.row(
            "user",
            {"role": "user", "content": "COPIED-HISTORY-NEVER-SENT"},
            sessionId="other-session",
        )

    def subagent(
        self,
        tool_use_id: str,
        agent_id: str = "abc",
        agent_type: str = "Explore",
        finished: bool | None = True,
        replies: int = 2,
    ) -> Transcript:
        folder = self.path.with_suffix("") / "subagents"
        folder.mkdir(parents=True, exist_ok=True)
        meta: dict[str, Any] = {
            "agentType": agent_type,
            "toolUseId": tool_use_id,
            "spawnDepth": 1,
            "description": "SUBAGENT-DESCRIPTION-NEVER-SENT",
        }
        if finished is not None:
            meta["finished"] = finished
        (folder / f"agent-{agent_id}.meta.json").write_text(json.dumps(meta), encoding="utf-8")
        sub = Transcript(folder / f"agent-{agent_id}.jsonl", self.session_id)
        sub.clock = self.clock
        sub.prompt("SUBAGENT-PROMPT-NEVER-SENT", isSidechain=True, agentId=agent_id)
        for i in range(replies):
            uses = (
                ((f"{tool_use_id}-sub-{i}", "Read", {"file_path": "/secret/path"}),)
                if i == 0
                else ()
            )
            sub.reply(
                message_id=f"{agent_id}-m{i}", tool_uses=uses, text="SUBAGENT-PROMPT-NEVER-SENT"
            )
            for sub_tool_use_id, _, _ in uses:
                sub.result(sub_tool_use_id)
        self.clock = sub.clock
        return sub


class Server:
    """Stands in for Telmoni: answers each export as told, 200 once the list runs out, and
    keeps every span it was sent."""

    def __init__(self, answers: list[int | tuple[int, str]] | None = None) -> None:
        self.answers = list(answers or [])
        # Every export as sent, and the ones answered 2xx, which is what Telmoni holds.
        self.exports: list[dict[str, Any]] = []
        self.accepted: list[dict[str, Any]] = []
        self.bodies: list[str] = []

    def __call__(self, url: str, headers: dict[str, str], body: bytes) -> Any:
        from telmoni.exporter import Answer

        text = body.decode("utf-8")
        self.bodies.append(text)
        self.exports.append(json.loads(text))
        answer = self.answers.pop(0) if self.answers else 200
        status, text = answer if isinstance(answer, tuple) else (answer, None)
        if status < 300:
            # A success may carry a partial success, which the SDK reads line by line.
            reply = (text or "{}").encode()
            self.accepted.append(self.exports[-1])
        else:
            # A refusal is problem details; the SDK reads the type off the message.
            reply = json.dumps({"message": f"{text or '/errors/test'}: refused"}).encode()
        return Answer(status=status, headers={}, body=reply)

    def spans(self) -> list[dict[str, Any]]:
        found = []
        for export in self.accepted:
            for resource in export.get("resourceSpans", []):
                for scope in resource.get("scopeSpans", []):
                    for span in scope.get("spans", []):
                        span = dict(span)
                        span["attrs"] = attributes(span.get("attributes", []))
                        span["resource"] = attributes(
                            resource.get("resource", {}).get("attributes", [])
                        )
                        found.append(span)
        return found

    def runs(self) -> list[dict[str, Any]]:
        """The run spans, in the order they were sent."""
        return self.by_attr("gen_ai.operation.name", "invoke_agent")

    def named(self, name: str) -> list[dict[str, Any]]:
        return [span for span in self.spans() if span.get("name") == name]

    def by_attr(self, key: str, value: Any) -> list[dict[str, Any]]:
        return [span for span in self.spans() if span["attrs"].get(key) == value]


def attributes(raw: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for item in raw:
        value = item.get("value", {})
        if "stringValue" in value:
            out[item["key"]] = value["stringValue"]
        elif "intValue" in value:
            out[item["key"]] = int(value["intValue"])
        elif "boolValue" in value:
            out[item["key"]] = value["boolValue"]
        elif "doubleValue" in value:
            out[item["key"]] = value["doubleValue"]
        else:
            out[item["key"]] = value
    return out


class Hook:
    """Runs the worker as a hook would, against a state folder and a server of the test's."""

    def __init__(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        self.state_dir = tmp_path / "data"
        self.state_dir.mkdir()
        self.env = {
            "CLAUDE_PLUGIN_DATA": str(self.state_dir),
            "CLAUDE_PLUGIN_OPTION_TELMONI_API_KEY": KEY,
            "CLAUDE_PLUGIN_OPTION_TELMONI_ENDPOINT": ENDPOINT,
        }
        self.server = Server()
        monkeypatch.setattr(worker, "SETTLE_QUIET_S", 0.02)
        monkeypatch.setattr(worker, "SETTLE_LIMIT_S", 0.1)
        monkeypatch.setattr(worker, "STOP_WAIT_S", 0.3)

    def run(
        self,
        transcript: Transcript,
        event: str = "Stop",
        error: str | None = None,
        busy: bool = False,
        env: dict[str, str] | None = None,
    ) -> int:
        payload = {
            "session_id": transcript.session_id,
            "transcript_path": str(transcript.path),
            "event": event,
            "error": error,
            "busy": busy,
        }
        return worker.run(
            payload, {**self.env, **(env or {})}, transport=self.server, sleep=lambda s: None
        )

    def state(self, session_id: str) -> dict[str, Any]:
        path = self.state_dir / f"{session_id}.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}

    def log(self) -> str:
        path = self.state_dir / "hook.log"
        return path.read_text(encoding="utf-8") if path.exists() else ""

    def kept(self) -> str:
        """Everything the plugin wrote to disk, for the secrets check."""
        return "".join(
            p.read_text(encoding="utf-8") for p in self.state_dir.iterdir() if p.is_file()
        )


@pytest.fixture
def hook(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Hook:
    return Hook(tmp_path, monkeypatch)


@pytest.fixture
def transcript(tmp_path: Path) -> Iterator[Transcript]:
    yield Transcript(tmp_path / "projects" / "p" / "session-one.jsonl", "session-one")


def assert_metadata_only(*texts: str) -> None:
    for text in texts:
        for secret in SECRETS:
            assert secret not in text, f"{secret} left the transcript"
