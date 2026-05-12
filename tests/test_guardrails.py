from chatbot_pipeline.guardrails import IDK_ANSWER, enforce_grounding


def test_enforce_grounding_returns_idk_without_required_citation() -> None:
    assert enforce_grounding("Revenue increased.", require_citation=True) == IDK_ANSWER


def test_enforce_grounding_keeps_cited_answer() -> None:
    answer = "Revenue increased. <doc=report.pdf;page=4>"
    assert enforce_grounding(answer, require_citation=True) == answer


def test_enforce_grounding_allows_uncited_answer_when_configured() -> None:
    assert enforce_grounding("Short answer.", require_citation=False) == "Short answer."
