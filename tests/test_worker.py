"""The hook end to end, the SDK included, against a Telmoni that answers as told."""

import io
import json
import os
import subprocess
import sys
import time
import types
from pathlib import Path

import telmoni_hook
import telmoni_worker
from telmoni_claude import __version__, record, state, worker
from telmoni_claude.send import Sender

from .conftest import KEY, Transcript, assert_metadata_only

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
    assert models[0]["attrs"]["gen_ai.usage.input_tokens"] == 18
    assert models[0]["attrs"]["gen_ai.usage.cache_read.input_tokens"] == 5
    assert models[0]["attrs"]["gen_ai.usage.cache_write.input_tokens"] == 3
    (tool,) = hook.server.by_attr("gen_ai.tool.name", "Bash")
    assert "error.type" not in tool["attrs"]
    assert hook.state("session-one")["offset"] == transcript.path.stat().st_size
    assert "sent" in hook.log()
    assert_metadata_only(*hook.server.bodies, hook.kept())


def test_names_a_model_wrote_leave_as_plain_names_and_a_long_one_loses_nothing(hook, transcript):
    transcript.prompt()
    transcript.reply(
        model="/data/models/NAME-PATH-NEVER-SENT/qwen-30b",
        tool_uses=(
            ("tu1", "run NAME-TEXT-NEVER-SENT now", {}),
            ("tu2", "Skill", {"skill": "NAME-TEXT-NEVER-SENT /secret/path"}),
            ("tu3", "Task", {"subagent_type": "NAME-TEXT-NEVER-SENT kind"}),
        ),
    )
    transcript.result("tu1")
    transcript.result("tu2")
    transcript.subagent("tu3", agent_type="NAME-TEXT-NEVER-SENT kind")
    transcript.result("tu3")
    transcript.reply(message_id="msg_2", model="x" * 300)
    assert hook.run(transcript) == 0
    (run,) = hook.server.runs()
    assert "skills" not in json.dumps(run["attrs"])
    models = sorted(
        s["attrs"]["gen_ai.request.model"]
        for s in hook.server.spans()
        if "gen_ai.request.model" in s["attrs"]
    )
    assert "unknown" in models and "x" * 128 in models
    assert hook.server.by_attr("gen_ai.tool.name", "unknown")
    assert "refused" not in hook.log()
    assert_metadata_only(*hook.server.bodies, hook.kept(), hook.log())


def test_the_provider_is_the_cloud_claude_code_is_set_to(hook, transcript, tmp_path):
    transcript.prompt()
    transcript.reply()
    hook.run(transcript, env={"CLAUDE_CODE_USE_BEDROCK": "1"})
    other = Transcript(tmp_path / "projects" / "p" / "session-two.jsonl", "session-two")
    other.prompt()
    other.reply()
    hook.run(other)
    providers = [
        s["attrs"]["gen_ai.provider.name"]
        for s in hook.server.spans()
        if "gen_ai.request.model" in s["attrs"]
    ]
    assert providers == ["aws.bedrock", "anthropic"]


def test_a_run_kept_without_a_provider_goes_as_anthropics(hook, transcript):
    transcript.prompt()
    transcript.reply()
    hook.server.answers = [503, 503, 503]
    hook.run(transcript, env={"CLAUDE_CODE_USE_VERTEX": "true"})
    path = hook.state_dir / "session-one.json"
    kept = json.loads(path.read_text(encoding="utf-8"))
    assert kept["pending"][0]["calls"][0]["provider"] == "gcp.vertex_ai"
    del kept["pending"][0]["calls"][0]["provider"]
    path.write_text(json.dumps(kept), encoding="utf-8")
    hook.run(transcript)
    (model,) = [s for s in hook.server.spans() if "gen_ai.request.model" in s["attrs"]]
    assert model["attrs"]["gen_ai.provider.name"] == "anthropic"


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


def test_the_work_a_blocking_stop_hook_carries_on_is_a_run_of_its_own(hook, transcript):
    transcript.prompt()
    transcript.reply()
    hook.run(transcript)
    transcript.stop_blocked()
    transcript.reply(message_id="msg_2", tool_uses=(("tu1", "Bash", {}),))
    transcript.result("tu1")
    transcript.reply(message_id="msg_3")
    hook.run(transcript)
    first, carried = hook.server.runs()
    assert first["attrs"]["telmoni.run_id"] != carried["attrs"]["telmoni.run_id"]
    assert hook.server.by_attr("gen_ai.tool.name", "Bash")
    models = [s for s in hook.server.spans() if "gen_ai.request.model" in s["attrs"]]
    assert len(models) == 3
    assert hook.state("session-one")["offset"] == transcript.path.stat().st_size
    assert_metadata_only(*hook.server.bodies, hook.kept(), hook.log())


def test_carried_on_work_read_under_way_waits_for_its_own_stop(hook, transcript):
    transcript.prompt()
    transcript.reply()
    # The blocking hook returned before this plugin's worker read the transcript.
    transcript.stop_blocked()
    transcript.reply(message_id="msg_2", tool_uses=(("tu1", "Bash", {}),))
    hook.run(transcript)
    assert len(hook.server.runs()) == 1
    transcript.result("tu1")
    transcript.reply(message_id="msg_3")
    hook.run(transcript)
    _, carried = hook.server.runs()
    models = [s for s in hook.server.spans() if "gen_ai.request.model" in s["attrs"]]
    assert len(models) == 3
    assert hook.server.by_attr("gen_ai.tool.name", "Bash")[0]["attrs"].get("error.type") is None
    assert carried["attrs"]["telmoni.run_id"] in hook.state("session-one")["sent"]


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


def test_a_reply_the_person_cut_short_is_a_cancelled_call(hook, transcript):
    transcript.prompt()
    transcript.reply()
    transcript.interrupt()
    hook.run(transcript)
    (model,) = [s for s in hook.server.spans() if "gen_ai.request.model" in s["attrs"]]
    assert model["attrs"].get("telmoni.cancelled") is True


def test_a_quiet_sessions_lock_is_swept_and_a_recent_one_kept(hook, transcript):
    week = time.time() - worker.SWEEP_AFTER_S - 60
    old = hook.state_dir / "gone.lock"
    old.touch()
    os.utime(old, (week, week))
    # A lock made long ago whose session saved its state lately is no quiet session's.
    saved = hook.state_dir / "saved.lock"
    saved.touch()
    os.utime(saved, (week, week))
    (hook.state_dir / "saved.json").write_text("{}", encoding="utf-8")
    recent = hook.state_dir / "recent.lock"
    recent.touch()
    transcript.prompt()
    transcript.reply()
    own = hook.state_dir / "session-one.lock"
    own.touch()
    os.utime(own, (week, week))
    hook.run(transcript)
    assert not old.exists() and saved.exists() and recent.exists() and own.exists()


def test_a_hook_that_waited_on_a_swept_lock_takes_the_one_at_the_path(tmp_path):
    path = tmp_path / "s.lock"
    first = state.Lock(path)
    assert first.acquire(0)
    path.unlink()
    second = state.Lock(path)
    # The old file is unlinked: the second takes a new one, which a third then cannot.
    assert second.acquire(0)
    assert not state.Lock(path).acquire(0)
    first.release()
    second.release()


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


def test_an_unreadable_state_is_left_alone_and_nothing_is_sent(hook, transcript):
    transcript.prompt()
    transcript.reply()
    path = hook.state_dir / "session-one.json"
    path.write_text('{"offset": 0, "sent": [', encoding="utf-8")
    hook.run(transcript)
    assert hook.server.exports == []
    assert path.read_text(encoding="utf-8") == '{"offset": 0, "sent": ['
    assert "state not read (JSONDecodeError); nothing sent" in hook.log()


def test_runs_sent_before_a_fault_are_remembered(hook, transcript, monkeypatch):
    transcript.prompt()
    transcript.reply()
    transcript.prompt()
    transcript.reply(message_id="msg_2")
    sent = Sender.send
    calls = []

    def once_then_fail(self, record, warned):
        calls.append(record["run_id"])
        if len(calls) > 1:
            raise RuntimeError("the worker died here")
        return sent(self, record, warned)

    monkeypatch.setattr(Sender, "send", once_then_fail)
    hook.run(transcript)
    assert "failed: RuntimeError" in hook.log()
    assert hook.state("session-one")["sent"] == calls[:1]
    monkeypatch.setattr(Sender, "send", sent)
    hook.run(transcript)
    assert [run["attrs"]["telmoni.run_id"] for run in hook.server.runs()] == calls


def test_a_kept_run_that_will_not_build_is_dropped_and_the_rest_go(hook, transcript):
    path = hook.state_dir / "session-one.json"
    path.write_text(json.dumps({"pending": [{"run_id": "old-shape"}]}), encoding="utf-8")
    transcript.prompt()
    transcript.reply()
    hook.run(transcript)
    assert len(hook.server.runs()) == 1
    assert "the record did not build: KeyError" in hook.log()
    state = hook.state("session-one")
    assert state["pending"] == [] and "old-shape" in state["sent"]


def test_the_state_is_the_owners_alone(hook, transcript):
    transcript.prompt()
    transcript.reply()
    hook.run(transcript)
    assert (hook.state_dir / "session-one.json").stat().st_mode & 0o777 == 0o600
    assert (hook.state_dir / "hook.log").stat().st_mode & 0o777 == 0o600
    assert not list(hook.state_dir.glob("*.tmp"))


def test_a_run_left_at_a_sessions_end_goes_with_another_sessions_hook(hook, transcript, tmp_path):
    transcript.prompt()
    transcript.reply()
    hook.server.answers = [503, 503, 503]
    hook.run(transcript, event="SessionEnd")
    assert (hook.state_dir / "session-one.pending").exists()
    left = hook.state("session-one")["pending"][0]["run_id"]
    other = Transcript(tmp_path / "projects" / "p" / "session-two.jsonl", "session-two")
    other.prompt()
    other.reply()
    hook.run(other)
    runs = [run["attrs"]["telmoni.run_id"] for run in hook.server.runs()]
    assert len(runs) == 2 and runs[-1] == left
    assert hook.state("session-one")["pending"] == []
    assert left in hook.state("session-one")["sent"]
    assert not (hook.state_dir / "session-one.pending").exists()


def test_a_left_run_goes_only_where_its_own_sessions_key_sends(hook, transcript, tmp_path):
    transcript.prompt()
    transcript.reply()
    hook.server.answers = [503, 503, 503]
    hook.run(transcript, event="SessionEnd")
    other = Transcript(tmp_path / "projects" / "p" / "session-two.jsonl", "session-two")
    other.prompt()
    other.reply()
    # Another endpoint beside the same key: the left run is that session's own next hook's.
    hook.run(other, env={"CLAUDE_PLUGIN_OPTION_TELMONI_ENDPOINT": "http://127.0.0.1:1"})
    assert len(hook.server.runs()) == 1
    assert len(hook.state("session-one")["pending"]) == 1
    assert (hook.state_dir / "session-one.pending").exists()


def test_a_left_run_waits_while_telmoni_is_away(hook, transcript, tmp_path):
    transcript.prompt()
    transcript.reply()
    hook.server.answers = [503, 503, 503]
    hook.run(transcript, event="SessionEnd")
    other = Transcript(tmp_path / "projects" / "p" / "session-two.jsonl", "session-two")
    other.prompt()
    other.reply()
    hook.server.answers = [200, 503, 503, 503]
    hook.run(other)
    assert len(hook.server.runs()) == 1
    assert len(hook.state("session-one")["pending"]) == 1
    assert (hook.state_dir / "session-one.pending").exists()


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


HOLD = """
import sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from telmoni_claude.state import Lock
assert Lock(Path(sys.argv[2])).acquire(0)
print("held", flush=True)
time.sleep(60)
"""


def test_a_live_hook_keeps_the_session_and_a_dead_one_does_not(hook, transcript):
    transcript.prompt()
    transcript.reply()
    lock = hook.state_dir / "session-one.lock"
    holder = subprocess.Popen(
        [sys.executable, "-c", HOLD, str(ROOT / "hooks"), str(lock)], stdout=subprocess.PIPE
    )
    try:
        assert holder.stdout.readline() == b"held\n"
        hook.run(transcript)
        assert hook.server.exports == []
        assert "another hook holds the session" in hook.log()
    finally:
        # A holder that dies, however it dies, lets go of the lock.
        holder.kill()
        holder.wait()
    hook.run(transcript, event="SessionEnd")
    assert len(hook.server.runs()) == 1


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


class Pipe:
    def __init__(self):
        self.data = b""
        self.closed = False

    def write(self, chunk):
        self.data += chunk
        return len(chunk)

    def close(self):
        self.closed = True


STOP = {
    "session_id": "s1",
    "transcript_path": "/tmp/s1.jsonl",
    "cwd": "/home/someone/secret-project",
    "hook_event_name": "Stop",
    "last_assistant_message": "REPLY-TEXT-NEVER-SENT",
}


def start_hook(monkeypatch, tmp_path, platform=None, uv=None):
    started = {}
    pipe = Pipe()
    monkeypatch.setattr(telmoni_hook.shutil, "which", lambda name: uv)

    def popen(args, **options):
        started["args"], started["options"] = args, options
        return types.SimpleNamespace(stdin=pipe)

    monkeypatch.setattr(subprocess, "Popen", popen)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(STOP)))
    monkeypatch.setenv("CLAUDE_PLUGIN_DATA", str(tmp_path))
    monkeypatch.delenv("TELMONI_HOOK_INLINE", raising=False)
    if platform:
        monkeypatch.setattr(sys, "platform", platform)
    assert telmoni_hook.main(["telmoni_hook.py"]) == 0
    return started, pipe


def test_the_hook_hands_the_session_to_a_worker_by_its_stdin_and_returns(monkeypatch, tmp_path):
    started, pipe = start_hook(monkeypatch, tmp_path)
    # The worker's argv is what ps shows: the payload goes by its stdin instead.
    assert started["args"] == [sys.executable, str(ROOT / "hooks" / "telmoni_worker.py")]
    assert started["options"]["stdin"] is subprocess.PIPE
    assert started["options"]["start_new_session"] is True
    assert pipe.closed and json.loads(pipe.data)["event"] == "Stop"
    kept = "".join(p.read_text(encoding="utf-8") for p in tmp_path.iterdir() if p.is_file())
    assert_metadata_only(pipe.data.decode("utf-8"), kept)


def test_with_uv_the_worker_fetches_the_sdk_itself(monkeypatch, tmp_path):
    started, _ = start_hook(monkeypatch, tmp_path, uv="/usr/bin/uv")
    worker = str(ROOT / "hooks" / "telmoni_worker.py")
    assert started["args"] == ["/usr/bin/uv", "run", "--quiet", "--script", worker]


def test_on_windows_the_worker_is_detached_by_its_creation_flags(monkeypatch, tmp_path):
    started, _ = start_hook(monkeypatch, tmp_path, platform="win32")
    flags = started["options"]["creationflags"]
    assert flags & telmoni_hook.CREATE_NO_WINDOW and flags & telmoni_hook.CREATE_NEW_PROCESS_GROUP
    assert "start_new_session" not in started["options"]


def test_the_worker_reads_its_payload_from_stdin(monkeypatch, tmp_path):
    payload = {
        "session_id": "s1",
        "transcript_path": str(tmp_path / "none.jsonl"),
        "event": "Stop",
        "error": None,
        "busy": False,
    }
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(payload)))
    monkeypatch.setenv("CLAUDE_PLUGIN_DATA", str(tmp_path))
    for name in ("TELMONI_API_KEY", "CLAUDE_PLUGIN_OPTION_TELMONI_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    assert telmoni_worker.main() == 0
    assert "no key" in (tmp_path / "hook.log").read_text(encoding="utf-8")


def test_the_hook_returns_0_with_no_folder_to_write(monkeypatch):
    def refused(env):
        raise OSError("read-only")

    monkeypatch.setattr(telmoni_hook.settings, "state_dir", refused)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(STOP)))
    monkeypatch.delenv("TELMONI_HOOK_INLINE", raising=False)
    assert telmoni_hook.main(["telmoni_hook.py"]) == 0


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
    assert "uv run --quiet --script" in command and "python3" in command
    # Neither uv nor python3 may fail the session: a Stop hook's exit 2 sends Claude back to work.
    assert command.count("|| true") == 2 and "exec" not in command
    assert plugin["userConfig"]["TELMONI_API_KEY"]["sensitive"] is True
    assert record.AGENT == "claude-code"
    hook = (ROOT / "hooks" / "telmoni_hook.py").read_text(encoding="utf-8")
    worker = (ROOT / "hooks" / "telmoni_worker.py").read_text(encoding="utf-8")
    # The hook fetches nothing before it runs: the SDK is the worker's alone.
    assert "# dependencies = []" in hook and "telmoni>=" not in hook
    assert '#   "telmoni>=0.2,<1",' in worker
    assert KEY not in hook and KEY not in worker


def hook_command():
    hooks = json.loads((ROOT / "hooks" / "hooks.json").read_text(encoding="utf-8"))
    return hooks["hooks"]["Stop"][0]["hooks"][0]["command"]


def test_the_hook_command_exits_0_when_uv_cannot_resolve_the_script(tmp_path):
    fake = tmp_path / "bin"
    fake.mkdir()
    uv = fake / "uv"
    uv.write_text("#!/bin/sh\necho 'error: Failed to fetch' >&2\nexit 2\n", encoding="utf-8")
    uv.chmod(0o755)
    env = {"PATH": f"{fake}:{os.environ['PATH']}", "CLAUDE_PLUGIN_ROOT": str(ROOT)}
    done = subprocess.run(
        ["/bin/sh", "-c", hook_command()], input=b"{}", env=env, capture_output=True
    )
    assert done.returncode == 0


def test_the_hook_command_exits_0_when_python3_fails_too(tmp_path):
    fake = tmp_path / "bin"
    fake.mkdir()
    python3 = fake / "python3"
    python3.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
    python3.chmod(0o755)
    env = {"PATH": str(fake), "CLAUDE_PLUGIN_ROOT": str(ROOT)}
    done = subprocess.run(
        ["/bin/sh", "-c", hook_command()], input=b"{}", env=env, capture_output=True
    )
    assert done.returncode == 0


def test_an_image_alone_is_a_prompt(hook, transcript):
    transcript.prompt()
    transcript.reply()
    transcript.image_prompt()
    transcript.reply(message_id="msg_2")
    transcript.image_prompt(with_origin=False, caption=True)
    transcript.reply(message_id="msg_3")
    hook.run(transcript)
    assert len(hook.server.runs()) == 3
    assert_metadata_only(*hook.server.bodies, hook.kept())


def test_a_tool_the_person_refused_is_cancelled_not_failed(hook, transcript):
    transcript.prompt()
    transcript.reply(tool_uses=(("tu1", "Bash", {"command": "rm /secret/path"}),))
    transcript.denied("tu1")
    transcript.prompt()
    transcript.reply(message_id="msg_3")
    hook.run(transcript)
    (tool,) = hook.server.by_attr("gen_ai.tool.name", "Bash")
    assert tool["attrs"].get("telmoni.cancelled") is True
    assert "error.type" not in tool["attrs"]
    stopped, _ = hook.server.runs()
    assert stopped["attrs"].get("telmoni.cancelled") is True
    assert_metadata_only(*hook.server.bodies, hook.kept())


def test_a_notice_answered_in_a_later_turn_completes_the_earlier_one(hook, transcript):
    launch_background(transcript)
    transcript.prompt()
    transcript.reply(message_id="msg_2")
    hook.run(transcript)
    assert hook.server.exports == []
    transcript.notice("tu1")
    transcript.reply(message_id="msg_3")
    hook.run(transcript)
    assert len(hook.server.runs()) == 2
    assert len(hook.server.named("subagent Explore")) == 1


def test_a_run_telmoni_took_in_part_is_logged_and_not_sent_again(hook, transcript):
    transcript.prompt()
    transcript.reply()
    dropped = "span 1 dropped gen_ai.usage.input_tokens: not_a_count"
    partial = {"partialSuccess": {"errorMessage": dropped}}
    hook.server.answers = [(200, json.dumps(partial))]
    hook.run(transcript)
    assert "taken in part" in hook.log()
    state_kept = hook.state("session-one")
    assert state_kept["pending"] == [] and len(state_kept["sent"]) == 1


def test_pending_runs_are_bounded_to_the_newest(hook, transcript, monkeypatch):
    monkeypatch.setattr(state, "PENDING_KEPT", 3)
    hook.server.answers = [503] * 60
    ids = []
    for i in range(5):
        prompt = transcript.prompt()
        transcript.reply(message_id=f"msg_{i}")
        hook.run(transcript)
        ids.append(record.run_id("session-one", prompt["uuid"]))
    kept = hook.state("session-one")
    assert [made["run_id"] for made in kept["pending"]] == ids[-3:]
    assert "dropped" in hook.log()
    hook.server.answers = []
    prompt = transcript.prompt()
    transcript.reply(message_id="msg_9")
    hook.run(transcript)
    sent = [run["attrs"]["telmoni.run_id"] for run in hook.server.runs()]
    assert sent == ids[-3:] + [record.run_id("session-one", prompt["uuid"])]
    assert hook.state("session-one")["pending"] == []


def test_a_compaction_opens_no_turn_of_its_own(hook, transcript):
    transcript.prompt()
    transcript.reply()
    # A manual /compact as Claude Code writes it: boundary, summary, caveat, command, output.
    transcript.tick(0.1)
    transcript.row(
        "system", subtype="compact_boundary", isMeta=True, content="COPIED-HISTORY-NEVER-SENT"
    )
    transcript.prompt(isCompactSummary=True, isVisibleInTranscriptOnly=True)
    transcript.meta("<local-command-caveat>PROMPT-TEXT-NEVER-SENT</local-command-caveat>")
    transcript.prompt("<command-name>/compact</command-name>")
    transcript.prompt("<local-command-stdout>PROMPT-TEXT-NEVER-SENT</local-command-stdout>")
    transcript.prompt()
    transcript.reply(message_id="msg_2")
    hook.run(transcript)
    assert len(hook.server.runs()) == 2
    assert hook.state("session-one")["offset"] == transcript.path.stat().st_size
    assert_metadata_only(*hook.server.bodies, hook.kept())


def test_a_run_the_sdk_has_no_room_for_is_refused_and_logged(hook, transcript, monkeypatch):
    import telmoni

    def full(self, made):
        raise telmoni.QueueFullError("no room")

    monkeypatch.setattr(telmoni.Telmoni, "record_run", full)
    transcript.prompt()
    transcript.reply()
    hook.run(transcript)
    assert "refused, not sent again" in hook.log() and "queue" in hook.log()
    kept = hook.state("session-one")
    assert kept["pending"] == [] and len(kept["sent"]) == 1


def test_without_the_sdk_the_run_waits_and_the_log_says_so_once(hook, transcript, monkeypatch):
    monkeypatch.setitem(sys.modules, "telmoni", None)
    transcript.prompt()
    transcript.reply()
    hook.run(transcript)
    transcript.prompt()
    transcript.reply(message_id="msg_2")
    hook.run(transcript)
    assert hook.log().count("SDK is not installed") == 1
    assert len(hook.state("session-one")["pending"]) == 2
