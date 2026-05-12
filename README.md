# PageIndex Grounded Chatbot

A Python repo for a document-grounded AI chatbot. It accepts PDFs and image files, including chart or graph screenshots. Images are converted into PDFs before being submitted because the current PageIndex document-processing SDK accepts PDF files.

The chatbot is intentionally strict: it asks PageIndex with a system prompt that forbids outside knowledge, enables PageIndex citations, and post-checks the answer. If the answer is not cited to the uploaded document, the API returns:

```text
I don't know
```

## Setup

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
Copy-Item .env.example .env
```

Edit `.env` and set:

```text
PAGEINDEX_API_KEY=your_pageindex_api_key_here
```

Get the key from the PageIndex developer dashboard.

## CLI Usage

Ingest PDFs or images:

```powershell
python -m chatbot_pipeline.cli ingest .\samples\manual.pdf .\samples\chart.png
```

Ask a question across all completed documents:

```powershell
python -m chatbot_pipeline.cli ask "What does the document say about revenue?"
```

Ask against one specific PageIndex document:

```powershell
python -m chatbot_pipeline.cli ask "What is the Q4 revenue?" --doc-id pi-your-doc-id
```

List known documents:

```powershell
python -m chatbot_pipeline.cli docs
```

## API Usage

Run the FastAPI server:

```powershell
python -m uvicorn chatbot_pipeline.api:app --reload
```

Open:

```text
http://127.0.0.1:8000/docs
```

Endpoints:

- `POST /ingest`: upload one or more files using multipart form-data field `files`.
- `POST /chat`: ask a grounded question.
- `GET /documents`: list locally tracked PageIndex document IDs.
- `POST /documents/status`: refresh a document status from PageIndex.
- `GET /health`: health check.

Example chat request:

```json
{
  "question": "What does the graph say about churn?",
  "doc_ids": ["pi-your-doc-id"]
}
```

Example response:

```json
{
  "answer": "I don't know",
  "doc_ids": ["pi-your-doc-id"]
}
```

## Pipeline

1. Validate input extension.
2. Copy the input into `data/uploads`.
3. Convert images into PDFs under `data/converted`.
4. Submit the PDF to PageIndex.
5. Poll PageIndex until the document is processed.
6. Store the `doc_id` in `data/state/documents.json`.
7. Answer questions only through PageIndex-scoped `doc_id` values.
8. Return `I don't know` when the answer lacks PageIndex page citations.

## Supported Inputs

- PDF: `.pdf`
- Images: `.png`, `.jpg`, `.jpeg`, `.webp`, `.bmp`, `.tif`, `.tiff`

For graph data files such as CSV, Excel, Mermaid, DOT, or JSON graph structures, export or render them as a PDF/image first, then ingest the rendered file.

## Important Notes

- PageIndex processing is a remote API call and requires `PAGEINDEX_API_KEY`.
- The strict citation guard is controlled by `REQUIRE_PAGEINDEX_CITATIONS=true`.
- If PageIndex produces a correct but uncited answer, this app still returns `I don't know`. That is intentional for safer grounding.
- Uploaded and converted files are ignored by git.

## Tests

```powershell
pytest
```
