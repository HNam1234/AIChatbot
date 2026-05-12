from __future__ import annotations

import time
from pathlib import Path
from typing import Any


class PageIndexGateway:
    def __init__(self, api_key: str) -> None:
        if not api_key:
            raise RuntimeError("PAGEINDEX_API_KEY is required. Add it to .env or your shell environment.")
        try:
            from pageindex import PageIndexClient
        except ImportError as exc:
            raise RuntimeError("The 'pageindex' package is not installed. Run: pip install -e .") from exc
        self._client = PageIndexClient(api_key=api_key)

    def submit_document(self, pdf_path: Path) -> str:
        result = self._client.submit_document(str(pdf_path))
        doc_id = result.get("doc_id")
        if not doc_id:
            raise RuntimeError(f"PageIndex did not return a doc_id: {result}")
        return str(doc_id)

    def get_document_status(self, doc_id: str) -> str:
        result = self._client.get_document(doc_id)
        return str(result.get("status", "unknown"))

    def wait_until_complete(self, doc_id: str, timeout_seconds: float, poll_interval_seconds: float) -> str:
        deadline = time.monotonic() + timeout_seconds
        last_status = "unknown"
        while time.monotonic() < deadline:
            last_status = self.get_document_status(doc_id)
            if last_status == "completed":
                return last_status
            if last_status == "failed":
                raise RuntimeError(f"PageIndex processing failed for {doc_id}")
            time.sleep(poll_interval_seconds)
        raise TimeoutError(f"Timed out waiting for {doc_id}; last status was '{last_status}'")

    def get_tree(self, doc_id: str) -> dict[str, Any]:
        return self._client.get_tree(doc_id)

    def chat(self, messages: list[dict[str, str]], doc_ids: str | list[str]) -> str:
        response = self._client.chat_completions(
            messages=messages,
            doc_id=doc_ids,
            temperature=0,
            enable_citations=True,
        )
        return str(response["choices"][0]["message"]["content"])
