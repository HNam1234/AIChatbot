# Milestone 4: Custom Agentic Retrieval via MCP with Round-Robin LLM Keys

Milestone 4 adds a custom agent on top of the PageIndex Tree Index generated in Milestone 2. The agent keeps retrieval cheap by using PageIndex MCP tools for targeted context, then uses a Gemini Flash-family model to synthesize a grounded answer.

Unlike the first token-minimized draft, this version does not force 15-word answers. It uses multiple configured Gemini keys in a Round-Robin client so the answer can include the HS Code, product/title, and a short classification reason while still avoiding full-document prompt stuffing.

This milestone is implemented as a first runtime slice. PageIndex MCP tool names, Gemini model names, quotas, and pricing should still be verified during operations because vendor APIs and limits can change.

## Goals

- Build a custom LLM agent that retrieves HS Code evidence from already indexed PageIndex documents.
- Avoid local vector database ingestion and full-document prompt stuffing.
- Use PageIndex MCP tools to retrieve only the target section or node needed for the answer.
- Use a Gemini Round-Robin client over multiple configured keys for availability and rate-limit failover.
- Allow concise, useful answers with a short explanation grounded in retrieved context.
- Add Marker 12 and Marker 13 to keep context and answer size bounded.

## Budget And Availability Strategy

Milestone 4 uses vectorless RAG with five controls:

1. Targeted extraction: call MCP tools to retrieve only the relevant section text.
2. Tree thinning: prefer compact PageIndex tree nodes and summaries over raw full documents.
3. Round-Robin keys: rotate across `GEMINI_KEY_1`, `GEMINI_KEY_2`, `GEMINI_KEY_3`, or any provided key list.
4. Failover: if one key hits a retryable quota/rate/transient error, try the next key without crashing the agent.
5. Bounded answers: allow explanation, but warn if the final answer becomes too long.

Use only API keys owned by the project and comply with the provider's terms and current quota policy. Treat expected request capacity as an implementation-time setting, not a fixed README guarantee.

## Architecture

```text
src/
+-- agent/
|   +-- mcpClient.ts         # Connect to PageIndex MCP server
|   +-- geminiClient.ts      # Round-Robin Gemini answer synthesis
|   +-- hsCodeAgent.ts       # Agent orchestration
+-- validators/
|   +-- tokenValidator.ts    # Marker 12 and Marker 13
+-- mainFlow.ts              # Optional agent mode entry point
```

## Dependencies

Installed packages:

```bash
npm install @modelcontextprotocol/sdk @google/genai
```

Environment:

```text
PAGEINDEX_API_KEY=your_pageindex_api_key
PAGEINDEX_MCP_URL=https://api.pageindex.ai/mcp

GEMINI_KEY_1=your_first_gemini_key
GEMINI_KEY_2=your_second_gemini_key
GEMINI_KEY_3=your_third_gemini_key

# Optional single-key fallback for local development
GEMINI_API_KEY=your_single_gemini_key
```

## MCP Client

Implemented in `src/agent/mcpClient.ts`. It uses the MCP Streamable HTTP transport against `https://api.pageindex.ai/mcp` with `Authorization: Bearer <PAGEINDEX_API_KEY>`. It discovers available tools, prefers tree/search/content tools, and can be forced with `--mcp-tool`.

## Gemini Round-Robin Client

Implemented in `src/agent/geminiClient.ts`. It uses the current Google GenAI SDK:

```ts
import { GoogleGenAI } from "@google/genai";
```

It rotates across `GEMINI_KEY_1`, `GEMINI_KEY_2`, `GEMINI_KEY_3`, then `GEMINI_API_KEY`. Retryable quota/rate/transient errors move to the next key without logging raw key values.

## Agent Orchestration

Implemented in `src/agent/hsCodeAgent.ts`. It connects MCP, retrieves targeted context, runs Marker 12, calls Gemini Round-Robin synthesis, then runs Marker 13.

## Marker 12 And Marker 13

Implemented in `src/validators/tokenValidator.ts`.

Marker 12 remains a hard gate before any LLM call. Marker 13 is a warning so the agent can answer naturally while still catching verbose outputs during development.

## Usage

Command:

```bash
npm run agent -- --doc-name "Chapter12.milestone1.md" --query "Find the HS Code for round cabbage"
```

## Acceptance Criteria

- Agent connects to PageIndex MCP using `PAGEINDEX_API_KEY`.
- Agent retrieves targeted context for a query using a PageIndex MCP tree/search tool.
- Marker 12 fails before LLM invocation if targeted context exceeds 1,500 characters.
- Gemini synthesis receives only targeted context, not full documents.
- Round-Robin client loads all configured Gemini key slots without logging raw key values.
- A retryable quota/rate/transient error on one Gemini key automatically tries the next configured key.
- Marker 13 warns if the final answer exceeds the configured word budget.
- The final answer may include the HS Code, product/title, and a short grounded reason.
- Milestone 4 does not mutate Milestone 1/2 parser outputs.

## Implementation Notes

- Keep Milestone 4 separate from Milestone 3 Chat API work. Milestone 3 uses PageIndex Chat API directly; Milestone 4 builds a custom agent with MCP plus a separate LLM.
- Do not pass full Markdown documents to Gemini.
- Log context length, answer word count, doc_id, selected MCP tool name, and Gemini key slot number for cost debugging.
- Never log raw API keys, raw environment values, or request headers.
- Validate current Gemini model names, pricing, and rate limits before release.
- Validate PageIndex MCP package/tool names before release.
- Use Round-Robin for availability across owned keys, not to bypass provider policy.

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
Milestone 3: PageIndex Chat API with citations
 |
 v
Milestone 4: custom MCP agent with Round-Robin LLM key failover
```
