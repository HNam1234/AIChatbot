# Flow Tổng Quan Của Repo

Repo này là một pipeline local để xử lý PDF tài liệu HS Code thành Markdown sạch, map section theo HS code, sinh PageIndex tree, sau đó hỏi đáp trên dữ liệu đã parse bằng local retrieval, PageIndex, MCP và Gemini.

Tên package: `aichatbot-local-pdf-parser`

Runtime chính:

- Node.js/TypeScript cho orchestration, server, API, QA agent.
- Python qua PyMuPDF/PyMuPDF4LLM/Docling cho đọc PDF, phân tích layout, OCR, crop ảnh.
- PageIndex API cho upload Markdown và sinh tree index.
- Gemini API cho query planning, query expansion và answer synthesis khi bật LLM.
- Express + UI tĩnh trong `src/ui` cho local notebook.

## 1. Entry Points

### CLI parse

Lệnh:

```bash
npm run parse -- <file.pdf>
npm run parse -- <directory> --batch
```

Entry point: `src/mainFlow.ts`

Luồng chính:

```text
mainFlow.ts
  -> executePipeline()
  -> inspectDocumentCache()
  -> runParsingPipeline()
  -> write Markdown/blocks/validation/sections
  -> optionally upload PageIndex and validate tree
  -> write cache.manifest.json
```

### CLI chat

Lệnh:

```bash
npm run chat -- --doc-id <doc_id> --query "..."
```

Entry point: `src/mainFlow.ts`, mode `chat`

Luồng:

```text
mainFlow.ts
  -> executeChatCli()
  -> cli/repl.ts
  -> ChatSession
  -> PageIndexClient.chatCompletion()
  -> QAValidator.validateResponse()
```

### CLI MCP agent

Lệnh:

```bash
npm run agent -- --doc-name <name> --query "..."
```

Entry point: `src/mainFlow.ts`, mode `agent`

Luồng:

```text
mainFlow.ts
  -> executeAgentCli()
  -> agent/hsCodeAgent.ts
  -> PageIndexMCP.retrieveTargetedContext()
  -> TokenValidator.validateContextSize()
  -> GeminiRoundRobinClient.synthesizeAnswer()
  -> TokenValidator.validateOutputSize()
```

### Local UI server

Lệnh:

```bash
npm run dev
```

Entry point: `src/server/server.ts`

Luồng:

```text
server.ts
  -> loadEnvConfig()
  -> Express app
  -> /api routes from server/routes.ts
  -> static UI from src/ui
  -> static assets from data/converted/assets
  -> optional tmp cleanup on startup
```

## 2. Flow Parse PDF Đầy Đủ

Đây là flow quan trọng nhất của repo.

```text
PDF input
  -> cache inspection
  -> layout analysis
  -> route từng page
  -> parse page bằng PyMuPDF hoặc Docling
  -> merge layout-only blocks
  -> filter artifacts/noise
  -> semantic fusion
  -> optional image asset export
  -> reconstruct HS Code Markdown
  -> validate Markdown markers 1-9
  -> write milestone artifacts
  -> build section map
  -> optional PageIndex upload/tree build
  -> validate tree marker 10
  -> write cache manifest
```

Chi tiết từng bước:

1. `executePipeline(pdfPath, options)` trong `src/mainFlow.ts` resolve option mặc định:
   - OCR mặc định: `vie+eng`.
   - Reuse parse cache mặc định: bật.
   - Reuse cached PageIndex tree mặc định: bật.
   - Force reparse/reupload mặc định: tắt.

2. `cache/cacheManifest.ts` kiểm tra cache:
   - Input PDF hash.
   - Markdown, blocks, validation, sections.
   - PageIndex tree và tree validation.
   - Asset image count.
   - Parse status: `missing`, `fresh`, `stale`, `failed`.
   - PageIndex status: `missing`, `fresh`, `stale`, `failed`.

3. Nếu parse cache fresh và không force:
   - Load Markdown, blocks, validation, section map từ `data/converted`.
   - Bỏ qua bước parse nặng.

4. Nếu cần parse lại:
   - `LayoutAnalyzer.analyze()` gọi `PyMuPDFWrapper.inspectLayout()`.
   - Kết quả layout gồm text blocks, image blocks, drawing blocks, table candidates.
   - Mỗi page được đánh dấu route `fast` hoặc `accurate`.

5. `SmartRouter.run()` chia page:
   - Page `fast`: gọi `PyMuPDFWrapper.convertPages()`.
   - Page `accurate`: gọi `DoclingWrapper.convertPages()`.
   - Nếu Docling lỗi và `allowPyMuPDFFallback` bật thì fallback sang PyMuPDF.
   - Router cũng tạo layout-only blocks từ layout text/image/table để dùng cho reconstruction, validation và mapping.

6. `ArtifactFilter.filter()` xử lý noise:
   - Lọc icon nhỏ, watermark, full-page background, ảnh lặp header/footer.
   - Mark `metadata.decorative = true`.
   - Chặn các artifact này vào Markdown/assets.

7. `SemanticFusion.fuse()`:
   - Xóa image duplicate theo IoU/center/size.
   - Link caption/source annotation gần ảnh.
   - Tạo block caption synthetic khi tìm được caption.
   - Propagate caption sang image cùng nhóm layout.

8. Nếu `exportAssets` bật:
   - `ImageAssetExporter.exportAssets()` crop ảnh không decorative bằng PyMuPDF.
   - Ghi PNG vào `data/converted/assets/<pdf-name>/`.
   - Gắn `assetPath`, `assetAbsolutePath`, width/height vào metadata của image block.

9. `HSCodeReconstructor.buildMarkdown()`:
   - Dùng layout blocks làm nguồn reconstruction chính.
   - Nhận diện `CHAPTER ...`.
   - Nhận diện HS code dạng `0000.00.00`.
   - Ghép HS code với title gần nhất.
   - Render section heading dạng `## <HS_CODE> — <title>`.
   - Render image/table/text theo reading order.
   - Chuẩn hóa Markdown table qua `normalizeMarkdownTables()`.

10. `MarkdownValidator.validatePhase1Detailed()` chạy Marker 1-9:
    - Marker 1: có heading hierarchy.
    - Marker 2: table nhất quán cột.
    - Marker 3: image-caption linkage trong tolerance.
    - Marker 4: thứ tự Chapter/HS code khớp layout.
    - Marker 5: HS code-title pairing đúng.
    - Marker 6: không drop HS code section.
    - Marker 7: không leak source vào caption.
    - Marker 8: caption không over-fusion.
    - Marker 9: image asset links tồn tại nếu asset export bật.

11. `SectionMapBuilder.build()` tạo section metadata:
    - `document`
    - `chapter`
    - `hsCode`
    - `title`
    - `section`
    - `pageStart`, `pageEnd`
    - `source`
    - `markdownHeading`
    - `textPreview`

12. Nếu `uploadPageIndex` bật:
    - Nếu tree cache fresh và reuse bật: `TreeBuilder.loadCached()`.
    - Nếu không: `TreeBuilder.buildAndWait()` upload Markdown lên PageIndex.
    - `PageIndexClient.uploadMarkdown()` gửi file Markdown.
    - Nếu PageIndex chưa trả tree ngay, poll `PageIndexClient.getTreeStatus()`.
    - Ghi `<file>.tree.json`.

13. `TreeValidator.validate()` chạy Marker 10:
    - Tree payload tồn tại.
    - HS code trong Markdown có trong tree.
    - Section map có đủ HS code.
    - Cảnh báo nếu thiếu summary/page range.

14. `writeCacheManifestRecord()` cập nhật `data/converted/cache.manifest.json`.

## 3. Flow Batch

Batch dùng `executeBatchPipeline(inputDir, options)` trong `src/mainFlow.ts`.

```text
directory input
  -> list *.pdf
  -> executePipeline(file) sequentially
  -> collect per-document summary
  -> collect all sections
  -> write batch outputs
```

Output batch:

- `data/converted/batch.manifest.json`
- `data/converted/all.sections.json`
- `data/converted/all.documents.json`

Nếu một file lỗi:

- File đó được ghi status `failed`.
- Batch vẫn tiếp tục với file sau, trừ khi flow UI truyền `failFast`.
- Cache manifest lưu error/action/status gần nhất.

## 4. Flow UI Upload Và Run Pipeline

UI tĩnh nằm trong:

- `src/ui/index.html`
- `src/ui/app.js`
- `src/ui/styles.css`
- `src/ui/textAlignment.js`

Server API nằm trong `src/server/routes.ts`.

Luồng khi user upload PDF và bấm Run Pipeline:

```text
Browser UI
  -> POST /api/cache-status
  -> POST /api/run-pipeline multipart
  -> JobStore.create()
  -> runJob()
  -> runPipelineProcess()
  -> spawn: npm run parse -- <file> ...
  -> poll GET /api/status/:jobId
  -> GET /api/result/:jobId
  -> GET /api/result/:jobId/document/:documentName
```

Các phần chính:

### `server/server.ts`

Dựng Express app:

- `express.json()`
- `/assets` serve `data/converted/assets`
- `/vendor/pdfjs` serve `pdfjs-dist/build`
- `/api` mount `createApiRouter()`
- static UI từ `src/ui`

### `server/routes.ts`

Route chính:

- `GET /api/settings`: trả trạng thái PageIndex/Gemini key đã mask.
- `POST /api/settings/pageindex-key`: ghi PageIndex key vào `.env` nếu local secret write được phép.
- `POST /api/settings/gemini-key`: ghi Gemini key hoặc slot key vào `.env`.
- `POST /api/settings/gemini-key-enabled`: bật/tắt Gemini slot.
- `POST /api/cache-status`: inspect cache cho danh sách file selected.
- `POST /api/run-pipeline`: nhận upload/cached input, tạo job, chạy pipeline async.
- `GET /api/status/:jobId`: trả snapshot progress/log.
- `GET /api/result/:jobId`: trả kết quả job.
- `GET /api/result/:jobId/document/:documentName`: trả bundle của document.
- `GET /api/pageindex-documents`: list cached tree documents.
- `GET /api/mapping`: list document có mapping.
- `GET /api/mapping/:documentName`: bundle mapping.
- `GET /api/mapping/:documentName/page/:pageNumber`: block mapping theo page.
- `GET /api/uploads/:filename`: serve PDF uploaded.
- `POST /api/ask`: hỏi đáp trên source đã chọn.

### `server/jobStore.ts`

Quản lý job trong memory:

- Tạo job id bằng `randomUUID()`.
- Track nhiều file trong cùng job.
- Track `queued`, `running`, `completed`, `failed`.
- Track per-file status `waiting`, `running`, `passed`, `failed`.
- Tính progress từ step names.
- Lưu logs ngắn hạn cho UI poll.

### `server/pipelineProcessRunner.ts`

Không gọi trực tiếp `executePipeline()` trong process server. Thay vào đó spawn CLI:

```text
npm run parse -- <inputFile> --ocr-lang ... --docling-threads ...
```

Lý do thực tế:

- Cách ly process parse nặng.
- Có timeout riêng.
- Dễ kill process tree nếu UI job timeout.
- Server nhận stdout/stderr để suy ra step progress.

## 5. Flow QA Qua UI `/api/ask`

Luồng QA trong UI có nhiều fallback để trả lời được cả khi chưa có live PageIndex.

```text
POST /api/ask
  -> parse question/scope/options
  -> load cached tree documents and/or local section maps
  -> optional query planning
  -> optional query expansion
  -> retrieve candidates
  -> enrich candidate with section metadata
  -> rank and validate candidates
  -> route by intent
  -> answer with local template/extractive path or Gemini
  -> validate/sanitize output
  -> return answer + citations + debug
```

Các mode dữ liệu:

- Cached PageIndex tree: đọc `<file>.tree.json`.
- Local sections: đọc `<file>.sections.json` hoặc `all.sections.json`.
- BM25 fallback: score local text khi tree không đủ.
- PageIndex live chat: dùng `PageIndexClient.chatCompletion()` nếu có doc_id/API key.
- Gemini synthesis: chỉ dùng khi key có và flow cần LLM.

Các bước chính trong `server/routes.ts`:

1. Tạo scope:
   - All documents.
   - Selected documents.
   - Manual `doc_id`.
   - Mixed cached tree + local sections.

2. `searchCachedTreeDocuments()`:
   - Load cached tree JSON.
   - Flatten tree nodes.
   - Search title/text theo query token.
   - Enrich hit bằng `qaAnswerFormatter.enrichRetrievedHit()`.
   - Rank/validate candidate.

3. `searchLocalSectionsOnly()`:
   - Load section metadata.
   - Search trực tiếp trên sections.
   - Dùng fallback khi không có tree usable.

4. Query planning:
   - `agent/queryPlanner.ts` rule-first.
   - Có thể dùng Gemini nếu bật LLM planner.
   - Intent gồm exact HS lookup, product classification, definition, chapter summary, document summary, selected section QA, attribute question, comparison, clarification.

5. Query expansion:
   - `agent/queryExpansion.ts`.
   - Mặc định tắt theo env.
   - Khi bật, Gemini tạo English retrieval terms/phrases.
   - Có cache in-memory theo normalized query/provider/model.

6. Candidate formatting/ranking:
   - `agent/qaAnswerFormatter.ts`.
   - Normalize section metadata.
   - Extract query signals: product terms, numeric ranges, physical attributes, scientific names, contrast terms.
   - Detect contrast trap như “khác với X”, “less than X”, “instead of X”.
   - Score và reject candidates yếu.
   - Render answer có citation metadata.

7. Intent routing:
   - `agent/qaIntentRouter.ts`.
   - Handler chính:
     - `handleExactHsCodeLookup()`
     - `handleChapterSummary()`
     - `handleDocumentSummary()`
     - `handleDefinition()`
     - `handleProductClassification()`
     - `handleSelectedSectionQa()`
     - `handleClarificationNeeded()`

8. Local answer:
   - `agent/localAnswerGenerator.ts`.
   - Trả lời classification bằng template từ metadata.
   - Trích definition/field từ section text.
   - Không cần gọi LLM nếu evidence đủ.

9. Gemini fallback:
   - `GeminiRoundRobinClient.synthesizeSectionAnswer()`.
   - Dùng nhiều key slot và failover khi key lỗi quota/rate/permission.

10. Response trả về UI gồm:
    - `answer`
    - `intent`
    - `answerMode`
    - `answerConfidence`
    - `citations`
    - `selectedPrimary`
    - `retrieval`
    - `indexSource`
    - `debug`
    - cache/index source details

## 6. Flow CLI PageIndex Chat

CLI chat là path đơn giản hơn UI QA.

```text
mainFlow.ts --mode chat
  -> resolvePageIndexSettings()
  -> cli/repl.ts
  -> ChatSession
  -> PageIndexClient.chatCompletion()
  -> QAValidator.validateResponse()
```

Module:

- `api/chatSession.ts`: giữ conversation history.
- `api/pageindexClient.ts`: gọi `/chat/completions`.
- `validators/qaValidator.ts`: kiểm tra citation inline dạng `<doc=...>`.

## 7. Flow MCP Agent

MCP agent dùng PageIndex MCP để retrieve targeted context rồi Gemini để trả lời.

```text
runAgenticQuery()
  -> PageIndexMCP.connect()
  -> list tools
  -> select compatible MCP tool
  -> build tool arguments from query/doc/page/folder
  -> call tool
  -> extract text
  -> truncate relevant snippet
  -> TokenValidator Marker 12
  -> GeminiRoundRobinClient.synthesizeAnswer()
  -> TokenValidator Marker 13
  -> close MCP
```

Module liên quan:

- `agent/hsCodeAgent.ts`: orchestrator của MCP + Gemini.
- `agent/mcpClient.ts`: MCP client, tool selection, argument mapping, snippet extraction.
- `agent/geminiClient.ts`: Gemini failover and prompting.
- `validators/tokenValidator.ts`: Marker 12/13.

## 8. Flow Mapping PDF ↔ Blocks ↔ Markdown

Mapping dùng cho UI xem spatial grounding.

```text
GET /api/mapping
  -> list available converted documents

GET /api/mapping/:documentName
  -> load blocks.json
  -> load sections.json
  -> load markdown
  -> normalize blocks
  -> assign sections to blocks
  -> return mapping payload

Browser
  -> pdfjs render PDF page to canvas
  -> overlay parsed block bbox
  -> extract PDF text spans
  -> align PDF span to parsed unit
  -> highlight matching block/section/markdown
```

Module liên quan:

- `server/routes.ts`: build mapping payload.
- `src/ui/app.js`: PDF.js rendering, overlays, selection state.
- `src/ui/textAlignment.js`: browser-side text matching.
- `src/alignment/textAlignment.ts`: TypeScript version tested by Vitest.

## 9. Module Map

### `src/mainFlow.ts`

Vai trò: orchestration CLI chính.

Dùng:

- Parse single PDF.
- Parse batch.
- CLI chat mode.
- CLI agent mode.
- Print summaries.
- Ghi outputs và manifest.

Import chính:

- `cache/cacheManifest`
- `cli/repl`
- `config/env`, `config/gemini`
- `orchestrator/*`
- `validators/*`
- `utils/paths`

### `src/types.ts`

Vai trò: type contract trung tâm.

Định nghĩa:

- `ParsedBlock`
- `LayoutAnalysis`
- `PageLayout`
- `RoutingPlan`
- `PipelineOptions`
- `ValidationReport`
- `SectionMapEntry`
- `PipelineResult`

Đây là file nên đọc đầu tiên khi thay đổi pipeline.

### `src/orchestrator/layoutAnalyzer.ts`

Vai trò: phân tích layout PDF.

Dùng:

- Gọi `PyMuPDFWrapper.inspectLayout()`.
- Enrich page layout.
- Detect scanned page, table, image, floating text.
- Quyết định route sơ bộ `fast`/`accurate`.

### `src/orchestrator/router.ts`

Vai trò: chọn parser theo page.

Dùng:

- Tạo routing plan.
- Page fast dùng PyMuPDF.
- Page accurate dùng Docling.
- Tạo layout-only parsed blocks cho text/image/table.

### `src/orchestrator/artifactFilter.ts`

Vai trò: loại artifact trực quan.

Dùng:

- Mark image decorative.
- Detect repeated positions, page edge, tiny icons, full-page backgrounds, alpha watermark.

### `src/orchestrator/semanticFusion.ts`

Vai trò: fusion giữa text/image/caption theo không gian.

Dùng:

- Remove duplicate images.
- Link image với caption/source gần nhất.
- Sinh caption block.
- Propagate caption trong image group.

### `src/orchestrator/imageAssetExporter.ts`

Vai trò: export ảnh nội dung.

Dùng:

- Crop bbox image bằng PyMuPDF.
- Ghi PNG.
- Gắn asset metadata cho Markdown reconstruction.

### `src/orchestrator/hsCodeReconstructor.ts`

Vai trò: dựng Markdown chuyên biệt cho HS Code.

Dùng:

- Đọc layout text lines.
- Parse Chapter.
- Parse HS code groups.
- Pair HS code với title.
- Render section headings và content.

### `src/orchestrator/consolidator.ts`

Vai trò: merger Markdown generic.

Dùng:

- Merge parsed blocks theo reading order.
- Normalize Markdown/table.
- Hiện tại `HSCodeReconstructor` là path chính cho HS docs, còn `Consolidator` là utility generic.

### `src/orchestrator/sectionMapBuilder.ts`

Vai trò: tạo metadata sections cho retrieval/citation.

Dùng:

- Extract `## <hsCode> — <title>` từ Markdown.
- Infer page range từ layout blocks.
- Extract source và text preview.

### `src/orchestrator/treeBuilder.ts`

Vai trò: PageIndex tree build/cache.

Dùng:

- Load cached tree.
- Upload Markdown.
- Poll PageIndex status.
- Ghi tree JSON kèm `sourceMarkdownSha256`.

### `src/tools/pyMuPDFWrapper.ts`

Vai trò: wrapper Python PyMuPDF/PyMuPDF4LLM.

Dùng:

- Inspect layout.
- Convert pages fast.
- Extract page subset cho Docling.
- Chạy Python inline qua `runProcess()`.
- Parse JSON từ stdout markers.

### `src/tools/doclingWrapper.ts`

Vai trò: wrapper Docling.

Dùng:

- Tách batch pages.
- Extract subset PDF bằng PyMuPDF.
- Chạy Docling current CLI, fallback legacy CLI.
- Thu Markdown/JSON output.
- Split Markdown theo page nếu có page break.

### `src/api/pageindexClient.ts`

Vai trò: PageIndex HTTP client.

Dùng:

- `uploadMarkdown()`: POST `/markdown/`.
- `getTreeStatus()`: GET `/doc/:docId/?type=tree&summary=true`.
- `chatCompletion()`: POST `/chat/completions`.

### `src/api/chatSession.ts`

Vai trò: giữ chat history cho PageIndex chat.

Dùng:

- Append system/user/assistant messages.
- Gọi `PageIndexClient.chatCompletion()`.

### `src/agent/hsCodeAgent.ts`

Vai trò: MCP + Gemini agent orchestration.

Dùng:

- Retrieve targeted context qua PageIndex MCP.
- Validate context size.
- Synthesize answer bằng Gemini.
- Validate answer word count.

### `src/agent/mcpClient.ts`

Vai trò: PageIndex MCP adapter.

Dùng:

- Connect MCP Streamable HTTP.
- List tools.
- Select search/structure/content tool.
- Build arguments theo schema tool.
- Extract text từ tool result.
- Truncate relevant snippet theo query.

### `src/agent/geminiClient.ts`

Vai trò: Gemini client có round-robin key failover.

Dùng:

- `synthesizeAnswer()` cho MCP context.
- `synthesizeSectionAnswer()` cho selected-section QA.
- `planQuery()` cho JSON planning/expansion.
- Retry/failover với lỗi key/quota/rate/5xx.

### `src/agent/queryPlanner.ts`

Vai trò: phân loại intent câu hỏi.

Dùng:

- Rule-first exact HS code/chapter/document summary.
- LLM planner nếu rule không đủ và config cho phép.
- Fallback selected-section/classification/clarification.

### `src/agent/queryExpansion.ts`

Vai trò: mở rộng query cho retrieval.

Dùng:

- Config qua env.
- Gemini provider hiện là provider mặc định khả dụng.
- Trả expanded query, terms, confidence, debug cache hit.

### `src/agent/qaAnswerFormatter.ts`

Vai trò: chuẩn hóa metadata, rank candidate, render answer/citation.

Dùng:

- Normalize `SectionMetadata`.
- Enrich tree hit bằng section map.
- Extract query signals.
- Detect contrast terms.
- Evaluate candidate relevance.
- Select relevant/alternative sections.
- Render HS code answer.

### `src/agent/qaIntentRouter.ts`

Vai trò: route câu hỏi sang handler trả lời.

Dùng:

- Detect intent.
- Handle exact lookup, product classification, definition, chapter/document summary, selected-section QA.
- Detect broad/ambiguous query.
- Sanitize final answer.

### `src/agent/localAnswerGenerator.ts`

Vai trò: trả lời local không cần LLM khi đủ evidence.

Dùng:

- Template classification từ metadata.
- Extractive definition.
- Extractive field/attribute answer.
- Safe fallback khi không đủ confidence.

### `src/agent/fieldExtractor.ts`

Vai trò: nhận diện field user hỏi.

Dùng:

- Synonym groups cho requirement/definition/appearance/usage/etc.
- Normalize requested field.
- Extract requested field từ section text.

### `src/server/server.ts`

Vai trò: bootstrap local Express server.

Dùng:

- Load env.
- Serve UI/assets/pdfjs.
- Mount API routes.
- Cleanup tmp on startup.

### `src/server/routes.ts`

Vai trò: API surface và QA orchestration cho UI.

Dùng:

- Settings/key management.
- Upload/cache/pipeline job.
- Result document bundle.
- Mapping payload.
- `/ask` QA route.
- Nhiều helper retrieval/ranking/debug nội bộ.

### `src/server/jobStore.ts`

Vai trò: in-memory job state.

Dùng:

- Track progress/logs/files.
- Snapshot cho polling UI.

### `src/server/pipelineProcessRunner.ts`

Vai trò: spawn CLI parse từ server.

Dùng:

- Build `npm run parse -- ...`.
- Inject temporary keys vào env child process.
- Infer step từ child stdout/stderr.
- Kill process tree khi timeout.

### `src/config/env.ts`

Vai trò: đọc và ghi config env.

Dùng:

- PageIndex config.
- Gemini key slots.
- Server host/port.
- Cleanup config.
- LLM QA/query expansion flags.
- Mask secret trước khi trả frontend.
- Ghi `.env` từ UI nếu host local hoặc explicit allow.

### `src/config/gemini.ts`

Vai trò: resolve Gemini keys.

Dùng:

- Ưu tiên override CLI/UI.
- Sau đó env key slots/legacy key.

### `src/cache/cacheManifest.ts`

Vai trò: cache manifest và freshness logic.

Dùng:

- Hash input Markdown/sections/tree source.
- Determine parse/pageindex cache status.
- Count sections/images.
- Read/write `data/converted/cache.manifest.json`.

### `src/validators/markdownValidator.ts`

Vai trò: validation Milestone 1, Marker 1-9.

Dùng:

- Gate trước khi ghi parse thành công.
- Bảo vệ Markdown khỏi lỗi structure/caption/assets/HS pairing.

### `src/validators/treeValidator.ts`

Vai trò: validation Milestone 2, Marker 10.

Dùng:

- Kiểm tree PageIndex/local section map có đủ HS code.
- Kiểm field id/summary/children.
- Emit warnings cho page range/summary.

### `src/validators/qaValidator.ts`

Vai trò: validation citation, Marker 11.

Dùng:

- Kiểm inline citation dạng `<doc=...>` cho PageIndex chat path.

### `src/validators/tokenValidator.ts`

Vai trò: validation context/output budget.

Dùng:

- Marker 12: targeted context <= max chars.
- Marker 13: answer <= max words.

### `src/validators/tokenValidator.ts`, `src/validators/treeValidator.ts`, `src/validators/markdownValidator.ts`

Các validator không chỉ test pass/fail, mà còn tạo marker report để UI và CLI hiển thị.

### `src/alignment/textAlignment.ts`

Vai trò: text alignment server/test version.

Dùng:

- Normalize text.
- Score PDF span ↔ parsed unit.
- Fallback block match by bbox/text.

### `src/ui/textAlignment.js`

Vai trò: text alignment browser version.

Dùng:

- UI mapping dùng để click PDF text span và highlight parsed block/Markdown unit tương ứng.

### `src/utils/paths.ts`

Vai trò: path helper.

Dùng:

- Ensure directory.
- Create temp dir.
- Resolve Python/Docling command.
- Default output artifact paths.

### `src/utils/process.ts`

Vai trò: run child process.

Dùng:

- Spawn Python/Docling.
- Capture stdout/stderr.
- Timeout/max buffer/check exit code.

### `src/utils/geometry.ts`

Vai trò: bbox math.

Dùng:

- Area, width, height, center.
- Intersection/IoU/distance/union/clamp.
- Layout analysis, artifact filter, semantic fusion.

### `src/utils/tempCleanup.ts`

Vai trò: cleanup `data/tmp`.

Dùng:

- Server startup cleanup.
- CLI `npm run clean:tmp`.

## 10. Data Directories Và Artifacts

Input:

```text
data/uploads/<file>.pdf
```

Main outputs:

```text
data/converted/<file>.milestone1.md
data/converted/<file>.milestone1.blocks.json
data/converted/<file>.milestone1.validation.json
data/converted/<file>.sections.json
data/converted/<file>.tree.json
data/converted/<file>.tree.validation.json
data/converted/assets/<file>/*.png
data/converted/cache.manifest.json
```

Batch outputs:

```text
data/converted/batch.manifest.json
data/converted/all.sections.json
data/converted/all.documents.json
```

Debug/tmp:

```text
data/tmp/*
```

## 11. NPM Scripts

```text
npm run build        -> tsc build
npm run typecheck    -> tsc noEmit with test config
npm test             -> vitest run
npm run parse        -> tsx src/mainFlow.ts
npm run parse:batch  -> tsx src/mainFlow.ts --batch
npm run chat         -> tsx src/mainFlow.ts --mode chat
npm run agent        -> tsx src/mainFlow.ts --mode agent
npm run eval:qa      -> tsx src/cli/qaEvalRunner.ts
npm run clean:tmp    -> tsx src/cli/cleanTmp.ts
npm run dev          -> tsx src/server/server.ts
npm run dev:watch    -> tsx watch src/server/server.ts
```

## 12. External Dependencies

### Runtime npm dependencies

- `express`: local server.
- `multer`: multipart PDF upload.
- `dotenv`: load `.env`.
- `pdfjs-dist`: browser PDF rendering assets.
- `@google/genai`: Gemini API.
- `@modelcontextprotocol/sdk`: MCP client.

### Dev dependencies

- `typescript`
- `tsx`
- `vitest`
- `@types/node`
- `@types/express`
- `@types/multer`

### Python/runtime tools

- PyMuPDF / `fitz`
- PyMuPDF4LLM
- Docling

## 13. Env Config Quan Trọng

PageIndex:

```env
PAGEINDEX_API_KEY=
PAGEINDEX_API_BASE_URL=https://api.pageindex.ai
PAGEINDEX_MCP_URL=https://api.pageindex.ai/mcp
PAGEINDEX_POLL_INTERVAL_MS=5000
PAGEINDEX_POLL_MAX_ATTEMPTS=60
```

Gemini:

```env
GEMINI_API_KEY=
GEMINI_KEY_1=
GEMINI_KEY_1_ENABLED=true
GEMINI_KEY_2=
GEMINI_KEY_2_ENABLED=true
GEMINI_KEY_3=
GEMINI_KEY_3_ENABLED=true
```

Server/UI:

```env
PORT=3000
HOST=127.0.0.1
MAX_CONCURRENT_JOBS=1
UI_PIPELINE_TIMEOUT_MS=600000
TMP_RETENTION_HOURS=24
TMP_CLEANUP_ON_START=true
ALLOW_LOCAL_SECRET_WRITE=false
```

LLM QA/query expansion:

```env
ENABLE_LLM_QA=false
ENABLE_LLM_QUERY_EXPANSION=false
QUERY_EXPANSION_PROVIDER=none
QUERY_EXPANSION_MAX_TERMS=12
QUERY_EXPANSION_TIMEOUT_MS=3000
QUERY_EXPANSION_CACHE_ENABLED=true
```

## 14. Những Điểm Cần Chú Ý Khi Sửa Repo

- `ParsedBlock` trong `src/types.ts` là contract sống còn. Thay đổi field ở đây cần kiểm tra toàn bộ parser, section map, mapping UI và QA.
- `HSCodeReconstructor` hiện là path Markdown chính cho HS Code docs. `Consolidator` là generic utility.
- UI server spawn `npm run parse`, nên log step trong `mainFlow.logStep()` ảnh hưởng trực tiếp progress UI.
- Cache freshness dựa trên hash. Nếu sửa logic output mà không force reparse, có thể thấy kết quả cũ.
- `routes.ts` đang là module lớn nhất, chứa cả API route, retrieval fallback và QA orchestration. Khi refactor nên tách theo domain: settings/upload/jobs/mapping/qa.
- API key không được log raw; các module hiện dùng masking/redaction cho UI và child process logs.
- PageIndex tree cache được xem fresh khi `treeSourceMarkdownHash` khớp hash Markdown hiện tại.
- QA local path cố tránh gọi LLM nếu template/extractive answer đủ confidence.
- Mapping UI phụ thuộc `blocks.json`, `sections.json`, Markdown và PDF uploaded còn tồn tại.

## 15. Sơ Đồ Module Rút Gọn

```text
CLI/UI input
  |
  v
mainFlow.ts -----------------------------+
  |                                      |
  v                                      v
cacheManifest.ts                  server/routes.ts
  |                                      |
  v                                      v
LayoutAnalyzer -> SmartRouter      JobStore -> pipelineProcessRunner
  |             |                        |
  |             +-> PyMuPDFWrapper       +-> npm run parse -> mainFlow.ts
  |             +-> DoclingWrapper
  v
ArtifactFilter
  v
SemanticFusion
  v
ImageAssetExporter optional
  v
HSCodeReconstructor
  v
MarkdownValidator
  v
SectionMapBuilder
  v
TreeBuilder optional -> PageIndexClient
  v
TreeValidator
  v
data/converted artifacts
  |
  +-> UI document viewer/mapping
  |
  +-> QA retrieval
        |
        +-> qaAnswerFormatter
        +-> qaIntentRouter
        +-> localAnswerGenerator
        +-> GeminiRoundRobinClient optional
        +-> PageIndexClient/PageIndexMCP optional
```

