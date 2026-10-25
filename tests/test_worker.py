"""The hook end to end, the SDK included, against a Telmoni that answers as told."""

import io
import json
import os
import subprocess
import sys
from pathlib import Path

import telmoni_hook
from telmoni_claude import __version__, record

from .conftest import KEY, assert_metadata_only

ROOT = Path(__file__).resolve().parents[1]


def test_a_turn_is_sent_as_a_run(hook, transcript):
    transcript.prompt()
    transcript.reply(tool_uses=(("tu1", "Bash", {"command": "cat /secret/path"}),))
    transcript.result("tu1")
    transcript.reply(message_id="msg_2")
    assert hook.run(transcript) == 0
    (run,) = hook.server.runs()
    assert run["attrs"]["gen_ai.conversation.id"] == "session-one"
    assert run["resource"]["service.version"] == "2.1.310"
    models = [s for s in hook.server.spans() if "gen_ai.request.model" in s["attrs"]]
    assert len(models) == 2
    assert models[0]["attrs"]["gen_ai.usage.input_tokens"] == 10
    assert models[0]["attrs"]["gen_ai.usage.cache_read.input_tokens"] == 5
    assert models[0]["attrs"]["gen_ai.usage.cache_write.input_tokens"] == 3
    (tool,) = hook.server.by_attr("gen_ai.tool.name", "Bash")
    assert "error.type" not in tool["attrs"]
    assert hook.state("session-one")["offset"] == transcript.path.stat().st_size
    assert "sent" in hook.log()
    assert_metadata_only(*hook.server.bodies, hook.kept())


def test_the_next_hook_sends_only_what_is_new(hook, transcript):
    transcript.prompt()
    transcript.reply()
    hook.run(transcript)
    transcript.prompt()
    transcript.reply(message_id="msg_2")
    hook.run(transcript)
    runs = hook.server.runs()
    assert len(runs) == 2
    assert len({run["attrs"]["telmoni.run_id"] for run in runs}) == 2
    assert len(hook.state("session-one")["sent"]) == 2


def test_an_interrupted_turn_is_a_cancelled_run(hook, transcript):
    transcript.prompt()
    transcript.reply(tool_uses=(("tu1", "Bash", {}),))
    transcript.result("tu1", interrupted=True)
    transcript.interrupt()
    transcript.prompt()
    transcript.reply(message_id="msg_3")
    hook.run(transcript)
    stopped, fine = hook.server.runs()
    assert stopped["attrs"].get("telmoni.cancelled") is True
    assert "telmoni.cancelled" not in fine["attrs"]
    (tool,) = hook.server.by_attr("gen_ai.tool.name", "Bash")
    assert tool["attrs"].get("telmoni.cancelled") is True
    assert "error.type" not in tool["attrs"]


def test_a_denied_tool_followed_by_a_reply_is_not_a_cancelled_run(hook, transcript):
    transcript.prompt()
    transcript.reply(tool_uses=(("tu1", "Bash", {}),))
    transcript.result("tu1", interrupted=True)
    transcript.interrupt(tool=True)
    transcript.reply(message_id="msg_2")
    hook.run(transcript)
    (run,) = hook.server.runs()
    assert "telmoni.cancelled" not in run["attrs"]


def test_a_failed_tool_fails_alone(hook, transcript):
    transcript.prompt()
    transcript.reply(tool_uses=(("tu1", "Bash", {}),))
    transcript.result("tu1", is_error=True)
    transcript.reply(message_id="msg_2")
    hook.run(transcript)
    (tool,) = hook.server.by_attr("gen_ai.tool.name", "Bash")
    assert tool["attrs"]["error.type"] == "ToolError"
    (run,) = hook.server.runs()
    assert "error.type" not in run["attrs"]


def test_an_api_error_ends_the_turn_failed(hook, transcript):
    transcript.prompt()
    transcript.reply(api_error="rate_limit")
    hook.run(transcript, event="StopFailure", error="rate_limit")
    (run,) = hook.server.runs()
    assert run["attrs"]["error.type"] == "rate_limit"
    (model,) = [s for s in hook.server.spans() if "gen_ai.request.model" in s["attrs"]]
    assert model["attrs"]["error.type"] == "rate_limit"


def test_a_stop_failure_names_the_error_the_transcript_lacks(hook, transcript):
    transcript.prompt()
    transcript.reply()
    hook.run(transcript, event="StopFailure", error="overloaded")
    (run,) = hook.server.runs()
    assert run["attrs"]["error.type"] == "overloaded"


def launch_background(transcript, finished=True):
    transcript.prompt()
    transcript.reply(
        tool_uses=(
            (
                "tu1",
                "Agent",
                {
                    "subagent_type": "Explore",
                    "run_in_background": True,
                    "prompt": "SUBAGENT-PROMPT-NEVER-SENT",
                },
            ),
        )
    )
    transcript.result("tu1", async_agent="abc")
    transcript.subagent("tu1", agent_id="abc", agent_type="Explore", finished=finished)


def test_a_background_subagent_holds_the_turn_until_its_notice_is_answered(hook, transcript):
    launch_background(transcript)
    hook.run(transcript)
    assert hook.server.exports == []
    assert hook.state("session-one")["offset"] == 0
    transcript.notice("tu1")
    transcript.reply(message_id="msg_2")
    hook.run(transcript)
    (run,) = hook.server.runs()
    (step,) = hook.server.named("subagent Explore")
    assert step["parentSpanId"] == run["spanId"]
    inner = [s for s in hook.server.spans() if s.get("parentSpanId") == step["spanId"]]
    assert sorted("model" if "gen_ai.request.model" in s["attrs"] else "tool" for s in inner) == [
        "model",
        "model",
        "tool",
    ]
    assert_metadata_only(*hook.server.bodies, hook.kept())


def test_a_subagent_still_running_holds_the_turn(hook, transcript):
    launch_background(transcript, finished=False)
    transcript.notice("tu1")
    transcript.reply(message_id="msg_2")
    hook.run(transcript)
    assert hook.server.exports == []
    meta = transcript.path.with_suffix("") / "subagents" / "agent-abc.meta.json"
    meta.write_text(
        json.dumps({**json.loads(meta.read_text()), "finished": True}), encoding="utf-8"
    )
    hook.run(transcript)
    assert len(hook.server.runs()) == 1


def test_the_sessions_end_sends_what_waits(hook, transcript):
    launch_background(transcript)
    hook.run(transcript, event="SessionEnd")
    assert len(hook.server.named("subagent Explore")) == 1


def test_a_busy_session_holds_its_open_turn_alone(hook, transcript):
    transcript.prompt()
    transcript.reply()
    hook.run(transcript, busy=True)
    assert hook.server.exports == []
    hook.run(transcript)
    assert len(hook.server.runs()) == 1


def test_what_telmoni_could_not_take_goes_first_next_time(hook, transcript):
    transcript.prompt()
    transcript.reply()
    hook.server.answers = [503, 503, 503]
    hook.run(transcript)
    state = hook.state("session-one")
    assert len(state["pending"]) == 1 and state["sent"] == []
    assert "not delivered" in hook.log()
    first_id = state["pending"][0]["run_id"]
    transcript.prompt()
    transcript.reply(message_id="msg_2")
    hook.run(transcript)
    runs = hook.server.runs()
    assert [run["attrs"]["telmoni.run_id"] for run in runs][0] == first_id
    assert len(runs) == 2
    assert hook.state("session-one")["pending"] == []


def test_a_refusal_is_final(hook, transcript):
    transcript.prompt()
    transcript.reply()
    hook.server.answers = [400]
    hook.run(transcript)
    state = hook.state("session-one")
    assert state["pending"] == [] and len(state["sent"]) == 1
    assert "refused, not sent again" in hook.log()
    hook.run(transcript)
    assert len(hook.server.exports) == 1


def test_a_database_failure_is_sent_again(hook, transcript):
    transcript.prompt()
    transcript.reply()
    hook.server.answers = [(500, "/errors/internal/database")]
    hook.run(transcript)
    assert len(hook.state("session-one")["pending"]) == 1


def test_without_a_key_nothing_is_sent_and_the_log_says_so_once(hook, transcript):
    transcript.prompt()
    transcript.reply()
    keyless = {"CLAUDE_PLUGIN_OPTION_TELMONI_API_KEY": "", "TELMONI_API_KEY": ""}
    hook.run(transcript, env=keyless)
    hook.run(transcript, env=keyless)
    assert hook.server.exports == []
    assert hook.log().count("no key") == 1


def test_a_live_hook_keeps_the_session_and_a_dead_one_does_not(hook, transcript):
    transcript.prompt()
    transcript.reply()
    lock = hook.state_dir / "session-one.lock"
    lock.write_text(f"{os.getpid()}:live", encoding="utf-8")
    hook.run(transcript)
    assert hook.server.exports == []
    assert "another hook holds the session" in hook.log()
    dead = next(pid for pid in range(400000, 500000) if not _alive(pid))
    lock.write_text(f"{dead}:gone", encoding="utf-8")
    hook.run(transcript, event="SessionEnd")
    assert len(hook.server.runs()) == 1
    assert not lock.exists()


def _alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def test_history_copied_from_another_session_is_passed_over(hook, transcript):
    transcript.other_session()
    transcript.other_session()
    transcript.prompt()
    transcript.reply()
    hook.run(transcript)
    assert len(hook.server.runs()) == 1
    assert_metadata_only(*hook.server.bodies, hook.kept())


def test_a_replaced_transcript_is_read_from_its_start(hook, transcript):
    transcript.prompt()
    transcript.reply()
    transcript.prompt()
    transcript.reply(message_id="msg_2")
    hook.run(transcript)
    transcript.path.write_text("", encoding="utf-8")
    transcript.count = 50
    transcript.prompt()
    transcript.reply(message_id="msg_9")
    hook.run(transcript)
    assert len(hook.server.runs()) == 3


def test_the_hook_hands_the_session_to_a_worker_and_returns(monkeypatch, tmp_path):
    started = {}

    def popen(args, **options):
        started["args"], started["options"] = args, options
        return None

    monkeypatch.setattr(subprocess, "Popen", popen)
    monkeypatch.setattr(
        sys,
        "stdin",
        io.StringIO(
            json.dumps(
                {
                    "session_id": "s1",
                    "transcript_path": "/tmp/s1.jsonl",
                    "hook_event_name": "Stop",
                }
            )
        ),
    )
    monkeypatch.setenv("CLAUDE_PLUGIN_DATA", str(tmp_path))
    monkeypatch.delenv("TELMONI_HOOK_INLINE", raising=False)
    assert telmoni_hook.main(["telmoni_hook.py"]) == 0
    assert started["args"][1:3] == [str(ROOT / "hooks" / "telmoni_hook.py"), "--work"]
    assert json.loads(started["args"][3])["event"] == "Stop"
    assert started["options"]["start_new_session"] is True
    assert started["options"]["stdin"] is subprocess.DEVNULL


def test_the_hook_leaves_cursor_alone(monkeypatch, tmp_path):
    monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: pytest_fail("a worker was started"))
    monkeypatch.setattr(
        sys,
        "stdin",
        io.StringIO(
            json.dumps(
                {
                    "session_id": "s1",
                    "transcript_path": "/tmp/s1.jsonl",
                    "hook_event_name": "Stop",
                }
            )
        ),
    )
    monkeypatch.setenv("CURSOR_VERSION", "1")
    assert telmoni_hook.main(["telmoni_hook.py"]) == 0


def pytest_fail(reason):
    raise AssertionError(reason)


def test_the_manifests_agree():
    plugin = json.loads((ROOT / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
    marketplace = json.loads(
        (ROOT / ".claude-plugin" / "marketplace.json").read_text(encoding="utf-8")
    )
    hooks = json.loads((ROOT / "hooks" / "hooks.json").read_text(encoding="utf-8"))
    project = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert plugin["version"] == __version__
    assert f'version = "{__version__}"' in project
    assert plugin["name"] == "telmoni-observability"
    assert [p["name"] for p in marketplace["plugins"]] == ["telmoni-observability"]
    assert marketplace["plugins"][0]["source"] == "./"
    assert sorted(hooks["hooks"]) == ["SessionEnd", "Stop", "StopFailure"]
    commands = {
        h["command"] for event in hooks["hooks"].values() for group in event for h in group["hooks"]
    }
    (command,) = commands
    assert "uv run --quiet --script" in command and "exec python3" in command
    assert plugin["userConfig"]["TELMONI_API_KEY"]["sensitive"] is True
    assert record.AGENT == "claude-code"
    assert KEY not in (ROOT / "hooks" / "telmoni_hook.py").read_text(encoding="utf-8")
