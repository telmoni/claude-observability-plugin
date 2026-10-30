import pytest
from telmoni_claude.send import Outcome, flush_seconds, judge


@pytest.mark.parametrize(
    ("warning", "outcome"),
    [
        ("telmoni: export refused with 400 /errors/telemetry/invalid-batch; dropped", "refused"),
        ("telmoni: export refused with 402 /errors/plan/limit-reached", "refused"),
        ("telmoni: export refused with 413 /errors/telemetry/batch-too-large", "refused"),
        ("telmoni: export refused with 500 /errors/internal/other", "refused"),
        ("telmoni: export refused with 500 /errors/internal/database", "undelivered"),
        ("telmoni: export refused with 401 /errors/auth/invalid-key", "undelivered"),
        ("telmoni: export refused with 403 /errors/auth/forbidden", "undelivered"),
        ("telmoni: export refused with 404 /errors/not-found", "undelivered"),
        (
            "telmoni: export failed after 3 attempts (503 /errors/telemetry/store-unavailable)",
            "undelivered",
        ),
        ("telmoni: an export failed (ConnectionError); the batch was dropped", "undelivered"),
        ("telmoni: the export queue was full; 3 spans were dropped", "undelivered"),
        ("telmoni: the server dropped gen_ai.usage.input_tokens (not a count)", "partial"),
        ("telmoni: a span past the 1 MiB an export may hold was dropped", "partial"),
        ("telmoni: the server said: something it did not keep", "partial"),
    ],
)
def test_what_the_sdks_warnings_mean(warning, outcome):
    assert judge([warning], True).outcome.value == outcome


def test_a_flush_that_timed_out_is_sent_again():
    assert judge([], False).outcome is Outcome.UNDELIVERED
    assert judge([], True).outcome is Outcome.SENT


def test_a_refusal_outranks_a_dropped_field():
    both = ["telmoni: the server dropped x (y)", "telmoni: export refused with 400 /e"]
    assert judge(both, True).outcome is Outcome.REFUSED


def test_a_batch_not_delivered_keeps_the_run_beside_one_refused():
    both = [
        "telmoni: export refused with 400 /errors/telemetry/invalid-batch; dropped",
        "telmoni: export failed after 3 attempts (503); the batch was dropped",
    ]
    assert judge(both, True).outcome is Outcome.UNDELIVERED
    assert judge(list(reversed(both)), True).outcome is Outcome.UNDELIVERED


def test_a_flush_waits_out_the_sdks_worst_case():
    assert flush_seconds(1) == 180
    assert flush_seconds(512) == 180
    assert flush_seconds(513) == 330
