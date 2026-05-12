from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable


@dataclass
class DocumentRecord:
    doc_id: str
    original_name: str
    uploaded_path: str
    submitted_path: str
    status: str
    created_at: str

    @classmethod
    def new(cls, doc_id: str, original_name: str, uploaded_path: Path, submitted_path: Path) -> "DocumentRecord":
        return cls(
            doc_id=doc_id,
            original_name=original_name,
            uploaded_path=str(uploaded_path),
            submitted_path=str(submitted_path),
            status="submitted",
            created_at=datetime.now(timezone.utc).isoformat(),
        )


class ManifestStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def list(self) -> list[DocumentRecord]:
        if not self.path.exists():
            return []
        data = json.loads(self.path.read_text(encoding="utf-8"))
        return [DocumentRecord(**item) for item in data.get("documents", [])]

    def get(self, doc_id: str) -> DocumentRecord | None:
        return next((record for record in self.list() if record.doc_id == doc_id), None)

    def upsert(self, record: DocumentRecord) -> None:
        records = [item for item in self.list() if item.doc_id != record.doc_id]
        records.append(record)
        self._write(records)

    def update_status(self, doc_id: str, status: str) -> None:
        records = self.list()
        for record in records:
            if record.doc_id == doc_id:
                record.status = status
                self._write(records)
                return

    def completed_ids(self) -> list[str]:
        return [record.doc_id for record in self.list() if record.status == "completed"]

    def _write(self, records: Iterable[DocumentRecord]) -> None:
        payload = {"documents": [asdict(record) for record in records]}
        tmp_path = self.path.with_suffix(".tmp")
        tmp_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp_path.replace(self.path)
