from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from .config import load_settings
from .pipeline import GroundedChatbotPipeline

app = FastAPI(title="PageIndex Grounded Chatbot", version="0.1.0")


class ChatRequest(BaseModel):
    question: str = Field(min_length=1)
    doc_ids: list[str] | None = None


class StatusRequest(BaseModel):
    doc_id: str = Field(min_length=1)


def get_pipeline() -> GroundedChatbotPipeline:
    return GroundedChatbotPipeline(load_settings())


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/documents")
def documents() -> dict[str, list[dict[str, str]]]:
    pipeline = get_pipeline()
    return {"documents": [record.__dict__ for record in pipeline.documents()]}


@app.post("/documents/status")
def refresh_status(request: StatusRequest) -> dict[str, str]:
    try:
        return {"doc_id": request.doc_id, "status": get_pipeline().refresh_status(request.doc_id)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/ingest")
def ingest(files: list[UploadFile] = File(...), wait: bool = True) -> dict[str, list[dict[str, str]]]:
    pipeline = get_pipeline()
    records = []
    for file in files:
        target = pipeline.settings.upload_dir / Path(file.filename or "upload").name
        with target.open("wb") as output:
            shutil.copyfileobj(file.file, output)
        try:
            record = pipeline.ingest(target, wait=wait)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"{file.filename}: {exc}") from exc
        records.append(record.__dict__)
    return {"documents": records}


@app.post("/chat")
def chat(request: ChatRequest) -> dict[str, str | list[str] | None]:
    try:
        answer = get_pipeline().ask(request.question, doc_ids=request.doc_ids)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"answer": answer, "doc_ids": request.doc_ids}
