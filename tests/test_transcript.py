import json

from telmoni_claude import transcript as t

from .conftest import Transcript


def rows(transcript):
    return t.read_rows(transcript.path, 0).rows


def test_rows_come_with_their_offsets_and_a_partial_line_waits(tmp_path):
    path = tmp_path / "s.jsonl"
    first, second = json.dumps({"type": "user", "n": 1}), json.dumps({"type": "user", "n": 2})
    path.write_text(first + "\n" + second + "\n" + '{"type": "us', encoding="utf-8")
    read = t.read_rows(path, 0)
    assert [row.offset for row in read.rows] == [0, len(first) + 1]
    assert read.end == len(first) + len(second) + 2
    assert not read.restarted
    with path.open("a", encoding="utf-8") as f:
        f.write('er", "n": 3}\n')
    later = t.read_rows(path, read.end)
    assert [row.data["n"] for row in later.rows] == [3]
    path.write_text(first + "\n", encoding="utf-8")
    assert t.read_rows(path, later.end).restarted


def test_what_counts_as_a_prompt(transcript):
    transcript.prompt()
    transcript.meta()
    transcript.companion()
    transcript.prompt("summary", isCompactSummary=True)
    transcript.reply(tool_uses=(("tu1", "Bash", {}),))
    transcript.result("tu1")
    transcript.interrupt()
    transcript.notice("tu1")
    transcript.prompt("<local-command-stdout>out</local-command-stdout>")
    transcript.prompt("")
    transcript.prompt("side", isSidechain=True)
    transcript.prompt("second")
    assert [t.is_prompt(row) for row in rows(transcript)] == [
        True,
        False,
        False,
        False,
        False,
        False,
        False,
        False,
        False,
        False,
        False,
        True,
    ]


def test_an_interruption_has_two_kinds(transcript):
    transcript.interrupt()
    transcript.interrupt(tool=True)
    transcript.prompt()
    assert [t.interruption(row) for row in rows(transcript)] == ["turn", "tool", None]


def test_a_notice_names_its_tool_call_and_a_launch_its_agent(transcript):
    transcript.notice("toolu_01")
    transcript.result("toolu_02", async_agent="agent-9")
    transcript.result("toolu_03")
    found = rows(transcript)
    assert t.notification_tool_use_id(found[0]) == "toolu_01"
    assert t.async_agent(found[1]) == "agent-9"
    assert t.async_agent(found[2]) is None


def test_usage_counts_the_cache_inside_input_and_sums_its_writes(transcript):
    transcript.reply(message_id="a")
    transcript.reply(
        message_id="b",
        usage={"input_tokens": 1, "output_tokens": 2, "cache_creation_input_tokens": 7},
    )
    transcript.reply(message_id="c", usage={"input_tokens": "many"})
    a, b, c = (t.usage(row) for row in rows(transcript))
    assert (a.input, a.output, a.cache_read, a.cache_write) == (18, 20, 5, 3)
    assert (b.input, b.cache_read, b.cache_write) == (8, None, 7)
    assert (c.input, c.output) == (None, None)


def test_an_api_error_gives_its_kind_and_never_its_message(transcript):
    transcript.reply(api_error="rate_limit")
    transcript.reply(message_id="b", api_error="something went wrong with the request")
    transcript.reply(message_id="c")
    assert [t.api_error(row) for row in rows(transcript)] == ["rate_limit", "ApiError", None]


def test_tool_uses_keep_a_name_a_skill_and_a_subagents_kind(transcript):
    transcript.reply(
        tool_uses=(
            ("tu1", "Bash", {"command": "ls /secret/path"}),
            ("tu2", "Skill", {"skill": "pr-review", "args": "x"}),
            (
                "tu3",
                "Agent",
                {"subagent_type": "Explore", "run_in_background": True, "prompt": "p"},
            ),
        )
    )
    (row,) = rows(transcript)
    uses = t.tool_uses(row)
    assert [(u.name, u.skill, u.subagent_type, u.background) for u in uses] == [
        ("Bash", None, None, False),
        ("Skill", "pr-review", None, False),
        ("Agent", None, "Explore", True),
    ]
    assert "secret" not in json.dumps([u.__dict__ for u in uses])


def test_names_are_plain_names_within_ingests_caps(transcript):
    transcript.reply(model="/data/models/NAME-PATH-NEVER-SENT/qwen-30b")
    transcript.reply(message_id="b", model="/models/NAME-PATH-NEVER-SENT/qwen3-coder.gguf")
    transcript.reply(message_id="c", model="  anthropic/claude-opus-5-5 ")
    transcript.reply(message_id="d", model="m" * 200)
    transcript.reply(
        message_id="e",
        tool_uses=(
            ("tu1", "read the file at NAME-TEXT-NEVER-SENT", {}),
            ("tu2", "Skill", {"skill": "NAME-TEXT-NEVER-SENT and more"}),
            ("tu3", "Agent", {"subagent_type": "/data/models/NAME-PATH-NEVER-SENT"}),
            ("tu4", "mcp__github__create_issue", {}),
        ),
    )
    found = rows(transcript)
    assert [t.model(row) for row in found] == [
        "unknown",
        "qwen3-coder.gguf",
        "anthropic/claude-opus-5-5",
        "m" * 128,
        "claude-opus-5-5",
    ]
    uses = t.tool_uses(found[-1])
    assert [(u.name, u.skill, u.subagent_type) for u in uses] == [
        ("unknown", None, None),
        ("Skill", None, None),
        ("Agent", None, None),
        ("mcp__github__create_issue", None, None),
    ]


def test_subagents_are_found_by_the_tool_call_that_started_them(transcript):
    transcript.subagent("tu1", agent_id="one", agent_type="Explore", finished=True)
    transcript.subagent("tu2", agent_id="two", agent_type="Plan", finished=None)
    folder = t.subagents_dir(transcript.path)
    (folder / "agent-orphan.meta.json").write_text('{"agentType": "X"}', encoding="utf-8")
    (folder / "agent-gone.meta.json").write_text('{"toolUseId": "tu9"}', encoding="utf-8")
    found = t.discover_subagents(transcript.path)
    assert sorted(found) == ["tu1", "tu2"]
    assert (found["tu1"].agent_type, found["tu1"].finished) == ("Explore", True)
    assert found["tu2"].finished is None
    assert t.discover_subagents(Transcript(transcript.path.parent / "x.jsonl", "x").path) == {}


def test_an_image_alone_is_a_prompt(transcript):
    transcript.image_prompt()
    transcript.image_prompt(with_origin=False)
    transcript.image_prompt(with_origin=False, caption=True)
    assert [t.is_prompt(row) for row in rows(transcript)] == [True, True, True]
