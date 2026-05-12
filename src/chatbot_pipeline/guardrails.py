from __future__ import annotations

import re

IDK_ANSWER = "I don't know"
PAGEINDEX_CITATION_RE = re.compile(r"<doc=[^>]+;page=\d+>", re.IGNORECASE)

SYSTEM_PROMPT = f"""You are a document-grounded assistant.
Use only the PageIndex-processed document content available through the scoped doc_id values.
Do not use outside knowledge, guesses, memory, assumptions, or general web knowledge.
If the answer is missing, ambiguous, or not directly supported by the documents, respond exactly:
{IDK_ANSWER}
For every factual claim that is supported, include PageIndex page citations when available.
Keep answers concise."""


def build_messages(question: str) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": question.strip()},
    ]


def enforce_grounding(answer: str, require_citation: bool) -> str:
    cleaned = (answer or "").strip()
    if not cleaned:
        return IDK_ANSWER
    if cleaned.lower().strip(". ") == IDK_ANSWER.lower():
        return IDK_ANSWER
    if require_citation and not PAGEINDEX_CITATION_RE.search(cleaned):
        return IDK_ANSWER
    return cleaned
