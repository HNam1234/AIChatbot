from __future__ import annotations

from pathlib import Path

from .config import Settings
from .documents import copy_to_uploads, prepare_for_pageindex
from .guardrails import build_messages, enforce_grounding
from .pageindex_gateway import PageIndexGateway
from .state import DocumentRecord, ManifestStore


class GroundedChatbotPipeline:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.store = ManifestStore(settings.manifest_path)
        self.pageindex = PageIndexGateway(settings.pageindex_api_key)

    def ingest(self, input_path: Path, wait: bool = True) -> DocumentRecord:
        uploaded_path = copy_to_uploads(input_path, self.settings.upload_dir)
        submitted_path = prepare_for_pageindex(uploaded_path, self.settings.converted_dir)
        doc_id = self.pageindex.submit_document(submitted_path)
        record = DocumentRecord.new(
            doc_id=doc_id,
            original_name=input_path.name,
            uploaded_path=uploaded_path,
            submitted_path=submitted_path,
        )
        self.store.upsert(record)

        if wait:
            record.status = self.pageindex.wait_until_complete(
                doc_id,
                timeout_seconds=self.settings.processing_timeout_seconds,
                poll_interval_seconds=self.settings.poll_interval_seconds,
            )
            self.store.upsert(record)
        return record

    def refresh_status(self, doc_id: str) -> str:
        status = self.pageindex.get_document_status(doc_id)
        self.store.update_status(doc_id, status)
        return status

    def ask(self, question: str, doc_ids: list[str] | None = None) -> str:
        scoped_doc_ids = doc_ids or self.store.completed_ids()
        if not scoped_doc_ids:
            return "I don't know"
        raw_answer = self.pageindex.chat(build_messages(question), scoped_doc_ids)
        return enforce_grounding(raw_answer, self.settings.require_pageindex_citations)

    def documents(self) -> list[DocumentRecord]:
        return self.store.list()
