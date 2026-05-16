# Milestone 3: Agentic Q&A and Reasoning Retrieval

Milestone 3 adds a question-answering layer on top of the Markdown, image assets, section maps, and PageIndex Tree Index produced by Milestones 1, 1.1, and 2.

The goal is to answer natural-language HS Code questions with grounded citations from the indexed source documents. Instead of building a local vector database, the pipeline should call the PageIndex Chat API and use PageIndex's tree-aware retrieval to reason over the uploaded document.

## Goals

- Connect to the PageIndex Chat API from Node.js/TypeScript.
- Let users ask natural-language questions about indexed HS Code reference documents.
- Enable inline citations so answers are tied back to the source document and page.
- Add Marker 11 as the Q&A gatekeeper for citation integrity.
- Keep answers conservative with low temperature and document-scoped retrieval.

Example question:

```text
Find the HS Code for an LCD monitor product.
```

Expected answer style:

```text
The suitable code is ... because ... <doc=ChapterXX.pdf;page=Y>
```

## Architecture

```text
src/
+-- api/
|   +-- pageindexClient.ts   # Add Chat API method alongside upload/tree methods
|   +-- chatSession.ts       # Conversation history and request shaping
+-- cli/
|   +-- repl.ts              # Interactive terminal chat
+-- validators/
|   +-- qaValidator.ts       # Marker 11 citation integrity check
+-- mainFlow.ts              # Add chat mode entry point or delegate to cli/repl.ts
```

## Execution Flow

1. Read the `doc_id` generated in Milestone 2. It may come from CLI args, a tree JSON file, or the batch manifest.
2. Start a chat session with optional conversation history.
3. Send the user query to `POST https://api.pageindex.ai/chat/completions`.
4. Scope retrieval to the target `doc_id`.
5. Enable citations with `enable_citations: true`.
6. Use low temperature, for example `0.1`, to keep answers conservative.
7. Run Marker 11 on the returned answer before displaying it as trusted output.

## Chat API Client

Implemented in `src/api/pageindexClient.ts` as `PageIndexClient.chatCompletion()`. It uses native `fetch`, posts to `/chat/completions`, scopes requests with optional `doc_id`, sets `stream: false`, and enables citations by default.

## Chat Session

Implemented in `src/api/chatSession.ts`. It keeps explicit user/assistant history and reuses `PageIndexClient.chatCompletion()` for each turn.

## Marker 11: Citation Integrity Check

Marker 11 validates that any factual answer includes at least one inline citation. In development mode, answers without citations should fail loudly so prompt/API settings can be corrected before users trust the output.

Implemented in `src/validators/qaValidator.ts`.

## CLI REPL

Implemented in `src/cli/repl.ts`. It supports one-shot questions and interactive chat.

## CLI Entry Point

Package script:

```bash
npm run chat -- --doc-id "doc_id_from_milestone_2" --query "Find the HS Code for round cabbage"
npm run chat -- --doc-id "doc_id_from_milestone_2"
```

The CLI should resolve `PAGEINDEX_API_KEY` the same way Milestone 2 does: explicit CLI flag first, then `.env` or environment variable.

## Acceptance Criteria

- User can start a chat session with a PageIndex `doc_id`.
- User can ask factual questions about an indexed HS Code document.
- Answers include inline citations such as `<doc=Chapter12.pdf;page=4>`.
- Marker 11 passes when citations are present.
- Marker 11 fails when an answer contains no citation.
- Chat mode does not require a local vector database.
- Chat mode does not mutate Milestone 1 or Milestone 2 parser outputs.

## Implementation Notes

- Keep `temperature` low, usually `0.1`.
- Keep retrieval scoped to one `doc_id` unless multi-document chat is explicitly added.
- Preserve raw citation strings in logs and validation output.
- Do not hide citation failures in development.
- If PageIndex changes the beta Chat API response shape, isolate that change in `PageIndexClient.chatCompletion()`.

## Relation To Earlier Milestones

```text
Milestone 1: clean Markdown + layout blocks + validation
 |
 v
Milestone 1.1: local image assets
 |
 v
Milestone 2: PageIndex Tree Index + section map
 |
 v
Milestone 3: agentic Q&A with inline citations
```

Milestone 3 should treat the previous outputs as read-only indexed knowledge. It should not re-parse PDFs or rebuild local chunks.
