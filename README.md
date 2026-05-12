# PageIndex Grounded Chatbot

TypeScript app for a document-grounded AI chatbot. It accepts PDFs and image files, including chart or graph screenshots. Images are converted into PDFs before upload because PageIndex document processing is PDF-oriented.

The chatbot is strict: it scopes each question to PageIndex `doc_id` values, asks for inline citations, and post-checks the response. If the answer is not grounded in uploaded documents, it returns:

```text
I don't know
```

## Setup

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env`:

```text
PAGEINDEX_API_KEY=your_pageindex_api_key_here
```

Get the key from the PageIndex developer dashboard.

## CLI Usage

Ingest PDFs or images:

```powershell
npm run cli -- ingest .\samples\manual.pdf .\samples\chart.png
```

Ask a question across all completed documents:

```powershell
npm run cli -- ask "What does the document say about revenue?"
```

Ask against one specific PageIndex document:

```powershell
npm run cli -- ask "What is the Q4 revenue?" --doc-id pi-your-doc-id
```

List known documents:

```powershell
npm run cli -- docs
```

After `npm run build`, you can also use:

```powershell
node dist/cli.js docs
```

## API Usage

Run the server:

```powershell
npm run dev
```

Open:

```text
http://127.0.0.1:8000/health
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
  "docIds": ["pi-your-doc-id"]
}
```

Example response:

```json
{
  "answer": "I don't know",
  "docIds": ["pi-your-doc-id"]
}
```

## Pipeline

1. Validate input extension.
2. Copy the input into `data/uploads`.
3. Convert images into PDFs under `data/converted`.
4. Submit the PDF to PageIndex through `@pageindex/sdk`.
5. Poll PageIndex until the document is processed.
6. Store the `docId` in `data/state/documents.json`.
7. Answer questions only through scoped PageIndex `doc_id` values.
8. Return `I don't know` when the answer lacks PageIndex page citations.

## Supported Inputs

- PDF: `.pdf`
- Images: `.png`, `.jpg`, `.jpeg`, `.webp`, `.bmp`, `.tif`, `.tiff`

For graph data files such as CSV, Excel, Mermaid, DOT, or JSON graph structures, export or render them as a PDF/image first, then ingest the rendered file.

## Scripts

```powershell
npm run build
npm test
npm run lint
npm run dev
```

## Notes

- PageIndex processing is a remote API call and requires `PAGEINDEX_API_KEY`.
- The strict citation guard is controlled by `REQUIRE_PAGEINDEX_CITATIONS=true`.
- If PageIndex produces a correct but uncited answer, this app still returns `I don't know`. That is intentional for safer grounding.
- Uploaded, converted, and temporary files are ignored by git.
