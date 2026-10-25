from datetime import timedelta

from telmoni_claude import transcript as t
from telmoni_claude import turns

from .conftest import T0


def build(transcript):
    read = t.read_rows(transcript.path, 0)
    return turns.assemble(read.rows, transcript.session_id, read.end), read


def at(seconds):
    return T0 + timedelta(seconds=seconds)


def test_a_prompt_closes_the_turn_before_it_and_the_last_stays_open(transcript):
    transcript.prompt()
    transcript.reply()
    second = transcript.prompt()
    transcript.reply(message_id="msg_2")
    found, read = build(transcript)
    assert [turn.open for turn in found] == [False, True]
    assert found[0].next_offset == read.rows[2].offset
    assert found[1].next_offset == read.end
    assert found[1].prompt_uuid == second["uuid"]


def test_a_model_call_runs_from_the_event_before_it(transcript):
    transcript.prompt()  # t=1
    transcript.reply(tool_uses=(("tu1", "Bash", {}),))  # t=2
    transcript.result("tu1")  # t=3
    transcript.reply(message_id="msg_2")  # t=4
    (turn,), _ = build(transcript)
    first, second = turn.model_calls
    assert (first.start, first.end) == (at(1), at(2))
    assert (second.start, second.end) == (at(3), at(4))
    (tool,) = turn.tool_calls
    assert (tool.start, tool.end) == (at(2), at(3))
    assert turn.end == at(4)


def test_the_rows_of_one_reply_are_one_call(transcript):
    transcript.prompt()
    transcript.reply(message_id="same")
    transcript.reply(message_id="same", usage={"input_tokens": 1, "output_tokens": 40})
    (turn,), _ = build(transcript)
    (call,) = turn.model_calls
    assert call.usage.output == 40
    assert call.end == at(3)


def test_a_tools_outcome(transcript):
    transcript.prompt()
    transcript.reply(
        tool_uses=(
            ("ok", "Read", {}),
            ("bad", "Bash", {}),
            ("stopped", "Bash", {}),
            ("never", "Bash", {}),
        )
    )
    transcript.result("ok")
    transcript.result("bad", is_error=True)
    transcript.result("stopped", interrupted=True)
    (turn,), _ = build(transcript)
    by_name = {tool.tool_use_id: tool for tool in turn.tool_calls}
    assert (by_name["ok"].error_type, by_name["ok"].cancelled) == (None, False)
    assert (by_name["bad"].error_type, by_name["bad"].cancelled) == ("ToolError", False)
    assert (by_name["stopped"].error_type, by_name["stopped"].cancelled) == (None, True)
    assert by_name["never"].end is None


def test_an_interruption_cancels_the_turn_unless_a_reply_follows(transcript):
    transcript.prompt()
    transcript.reply(tool_uses=(("tu1", "Bash", {}),))
    transcript.result("tu1", interrupted=True)
    transcript.interrupt(tool=True)
    transcript.reply(message_id="msg_2")
    transcript.prompt()
    transcript.reply(message_id="msg_3")
    transcript.interrupt()
    went_on, stopped = build(transcript)[0]
    assert went_on.ended_by_interruption is False
    assert stopped.ended_by_interruption is True
    assert stopped.end == at(8)


def test_a_background_subagent_keeps_the_turn_waiting(transcript):
    transcript.prompt()
    transcript.reply(
        tool_uses=(("tu1", "Agent", {"subagent_type": "Explore", "run_in_background": True}),)
    )
    transcript.result("tu1", async_agent="abc")
    (turn,), _ = build(transcript)
    assert not turns.is_complete(turn, "Stop", False, {})
    assert turns.is_complete(turn, "SessionEnd", False, {})
    transcript.notice("tu1")
    (turn,), _ = build(transcript)
    assert not turns.is_complete(turn, "Stop", False, {})
    transcript.reply(message_id="msg_2")
    (turn,), _ = build(transcript)
    assert turns.is_complete(turn, "Stop", False, {})
    assert not turns.is_complete(turn, "Stop", True, {})
    still_running = {"tu1": t.Subagent("tu1", "Explore", False, transcript.path)}
    assert not turns.is_complete(turn, "Stop", False, still_running)
    transcript.prompt()
    closed, _ = build(transcript)[0]
    assert turns.is_complete(closed, "Stop", True, {})


def test_what_ended_a_turn_in_error(transcript):
    transcript.prompt()
    transcript.reply(api_error="rate_limit")
    transcript.prompt()
    transcript.reply(message_id="msg_2")
    failed, fine = build(transcript)[0]
    assert turns.error_type(failed, "StopFailure", "overloaded") == "rate_limit"
    assert turns.error_type(fine, "StopFailure", "overloaded") == "overloaded"
    assert turns.error_type(fine, "Stop", None) is None
    assert turns.error_type(failed, "Stop", None) == "rate_limit"
    failed.open = False
    assert turns.error_type(fine.__class__(0, "", at(0), at(0)), "StopFailure", None) == "unknown"


def test_rows_copied_from_another_session_are_passed_over(transcript):
    transcript.other_session()
    transcript.other_session()
    transcript.prompt()
    transcript.reply()
    found, _ = build(transcript)
    assert len(found) == 1


def test_a_subagents_transcript_is_one_span_of_work(transcript):
    sub = transcript.subagent("tu1", replies=2)
    models, tools, ended = turns.collect(t.read_rows(sub.path, 0).rows)
    assert len(models) == 2 and len(tools) == 1
    assert ended == sub.clock
