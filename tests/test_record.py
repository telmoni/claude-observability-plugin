import json

from telmoni_claude import record, turns
from telmoni_claude import transcript as t

from .conftest import assert_metadata_only


def build(transcript, event="Stop", error=None):
    read = t.read_rows(transcript.path, 0)
    found = turns.assemble(read.rows, transcript.session_id, read.end)
    subagents = t.discover_subagents(transcript.path)
    return [
        record.build(
            turn,
            transcript.session_id,
            event,
            error,
            subagents,
            lambda s: t.read_rows(s.path, 0).rows,
        )
        for turn in found
    ]


def test_a_run_id_is_the_same_each_time_and_the_sessions_own():
    assert record.run_id("s", "u") == record.run_id("s", "u")
    assert record.run_id("s", "u") != record.run_id("s2", "u")
    assert record.run_id("s", "u") != record.run_id("s", "u2")


def test_a_turn_becomes_a_run_with_its_calls_in_order(transcript):
    transcript.prompt()
    transcript.reply(
        tool_uses=(("tu1", "Skill", {"skill": "pr-review"}), ("tu2", "Bash", {"command": "x"}))
    )
    transcript.result("tu1")
    transcript.result("tu2", is_error=True)
    transcript.reply(message_id="msg_2")
    (made,) = build(transcript)
    assert made["agent"] == "claude-code"
    assert made["session_id"] == "session-one"
    assert made["release"] == "2.1.310"
    assert made["tags"] == {"skills": "pr-review"}
    assert [c["kind"] for c in made["calls"]] == ["model", "tool", "tool", "model"]
    assert [c.get("name") for c in made["calls"]][1:3] == ["Skill", "Bash"]
    assert made["calls"][2]["error_type"] == "ToolError"
    assert made["calls"][0]["usage"] == {
        "input": 18,
        "output": 20,
        "cache_read": 5,
        "cache_write": 3,
    }
    assert (made["error_type"], made["cancelled"]) == (None, False)
    assert record.spans(made) == 5
    assert_metadata_only(json.dumps(made))


def test_a_call_never_answered_is_cancelled_with_the_turn(transcript):
    transcript.prompt()
    transcript.reply(tool_uses=(("tu1", "Bash", {}),))
    transcript.interrupt()
    (made,) = build(transcript)
    assert made["cancelled"] is True
    assert made["calls"][1]["cancelled"] is True
    assert made["calls"][1]["end"] == made["end"]


def test_a_subagent_is_a_step_holding_its_own_calls(transcript):
    transcript.prompt()
    transcript.reply(
        tool_uses=(
            ("tu1", "Agent", {"subagent_type": "Explore", "prompt": "SUBAGENT-PROMPT-NEVER-SENT"}),
        )
    )
    transcript.subagent("tu1", replies=2)
    transcript.result("tu1")
    transcript.reply(message_id="msg_2")
    (made,) = build(transcript)
    step = made["calls"][1]
    assert step["kind"] == "step" and step["name"] == "subagent Explore"
    assert [c["kind"] for c in step["calls"]] == ["model", "tool", "model"]
    assert record.spans(made) == 1 + 1 + (1 + 3) + 1
    assert_metadata_only(json.dumps(made))


def test_the_skills_tag_is_cut_at_a_name(transcript):
    transcript.prompt()
    uses = tuple((f"tu{i}", "Skill", {"skill": f"skill-number-{i:02d}"}) for i in range(40))
    transcript.reply(tool_uses=uses)
    (made,) = build(transcript)
    tag = made["tags"]["skills"]
    assert len(tag) <= record.TAG_MAX
    assert all(name.startswith("skill-number-") and len(name) == 15 for name in tag.split(","))
