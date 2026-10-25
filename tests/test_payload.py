import json

from telmoni_claude import payload as hook_payload


def stop(**over):
    data = {
        "session_id": "s1",
        "transcript_path": "~/.claude/projects/x/s1.jsonl",
        "cwd": "/x",
        "hook_event_name": "Stop",
        "stop_hook_active": False,
        "last_assistant_message": "PROMPT-TEXT-NEVER-SENT",
        "background_tasks": [],
        "session_crons": [],
    }
    data.update(over)
    return json.dumps(data)


def test_a_stop_is_read_with_its_transcript_expanded():
    got = hook_payload.parse(stop(), {})
    assert got is not None
    assert (got.session_id, got.event, got.error, got.busy) == ("s1", "Stop", None, False)
    assert got.transcript_path.endswith("/.claude/projects/x/s1.jsonl")
    assert "~" not in got.transcript_path


def test_a_stop_failure_names_its_error_kind():
    got = hook_payload.parse(stop(hook_event_name="StopFailure", error="rate_limit"), {})
    assert got is not None and got.error == "rate_limit"
    nameless = hook_payload.parse(stop(hook_event_name="StopFailure"), {})
    assert nameless is not None and nameless.error == "unknown"


def test_a_session_end_is_read():
    got = hook_payload.parse(stop(hook_event_name="SessionEnd", reason="other"), {})
    assert got is not None and got.event == "SessionEnd"


def test_what_is_not_ours_is_left_alone():
    assert hook_payload.parse(stop(hook_event_name="PreToolUse"), {}) is None
    assert hook_payload.parse(stop(session_id="../etc"), {}) is None
    assert hook_payload.parse(stop(transcript_path=""), {}) is None
    assert hook_payload.parse("", {}) is None
    assert hook_payload.parse("not json", {}) is None
    assert hook_payload.parse("[1]", {}) is None


def test_a_background_subagent_marks_the_session_busy():
    assert hook_payload.parse(stop(background_tasks=[{"type": "shell"}]), {}).busy is False
    busy = hook_payload.parse(
        stop(background_tasks=[{"type": "subagent", "status": "running"}]), {}
    )
    assert busy.busy is True


def test_cursor_records_its_own_conversations():
    assert hook_payload.parse(stop(), {"CURSOR_VERSION": "1.0"}) is None
    assert hook_payload.parse(stop(conversation_id="c1"), {}) is None


def test_a_payload_survives_the_trip_to_the_worker():
    got = hook_payload.parse(stop(hook_event_name="StopFailure", error="overloaded"), {})
    assert hook_payload.Payload.from_dict(json.loads(json.dumps(got.as_dict()))) == got
