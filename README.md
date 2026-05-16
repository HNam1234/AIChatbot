# Local PDF Parser + PageIndex Tree Pipeline

Pipeline TypeScript parse PDF HS Code thành Markdown chuẩn, export ảnh nội dung, upload Markdown lên PageIndex để sinh Tree Index, rồi dùng cho RAG/Q&A ở milestone sau.

## Milestones

- [Milestone 1: Local PDF Parser](docs/milestones/milestone-1.md)
- [Milestone 1.1: Image Asset Export](docs/milestones/milestone-1-1.md)
- [Milestone 2: PageIndex Tree Generation](docs/milestones/milestone-2.md)

## Prerequisites

- Node.js 18+
- Python 3.10+
- Git
- PageIndex API key nếu chạy `--upload-pageindex`

## Install

Windows:

```bash
npm install
python -m venv .venv
.venv\Scripts\activate
pip install pymupdf pymupdf4llm docling
```

macOS/Linux:

```bash
npm install
python -m venv .venv
source .venv/bin/activate
pip install pymupdf pymupdf4llm docling
```

## Add API Key

### Option A: Add API key via `.env`

Tạo `.env` từ `.env.example`:

```text
PAGEINDEX_API_KEY=your_key_here
GEMINI_API_KEY=your_gemini_key_here
PAGEINDEX_API_BASE_URL=https://api.pageindex.ai
PAGEINDEX_POLL_INTERVAL_MS=5000
PAGEINDEX_POLL_MAX_ATTEMPTS=60
UI_PIPELINE_TIMEOUT_MS=600000
PORT=3000
```

Không commit `.env`. Repo đang ignore `data/uploads`, `data/converted` và `data/tmp`; chỉ giữ `.gitkeep`.

### Option B: Add API key via UI

Chạy UI:

```bash
npm run dev
```

Mở `http://localhost:3000`, nhập key vào panel `API Settings`.

- PageIndex key: dùng cho `--upload-pageindex`.
- Gemini key: dành cho Milestone 3 Q&A/LLM sau này.
- Temporary key mode: tick `Use ... key only for this run`; key chỉ được truyền cho job hiện tại qua environment, không lưu disk.
- Save key mode: bấm `Save ... Key to .env`; backend chỉ set/replace key tương ứng và giữ các biến `.env` khác.
- UI/API chỉ hiện masked key dạng `********...abcd`; raw key không được trả về, không log ra terminal, không ghi job logs, không lưu localStorage.

## Run Local Parse

```bash
npm run parse -- data/uploads/Chapter12.pdf --ocr-lang vie --docling-threads 4
```

Full single-document workflow with image export and PageIndex tree generation:

```bash
npm run parse -- data/uploads/Chapter12.pdf --ocr-lang vie --docling-threads 4 --export-assets --upload-pageindex
```

Output:

```text
data/converted/<file>.milestone1.md
data/converted/<file>.milestone1.blocks.json
data/converted/<file>.milestone1.validation.json
data/converted/<file>.sections.json
```

## Markdown Reconstruction Notes

Pipeline rebuilds Markdown from local layout blocks instead of trusting raw parser Markdown. The expected HS section format is:

```md
## 0102.29.11 — OXEN

Body text...

(Source: Indonesia)
```

Grouped HS codes that share one title are rendered as separate searchable H2 sections. Each grouped section includes the grouped code set and a duplicated shared-description block so retrieval works even when the query names an earlier code in the group:

```md
## 0105.11.10 — BREEDING

Grouped HS code set: 0105.11.10, 0105.12.10, 0105.13.10, 0105.14.10, 0105.15.10, 0105.94.10, 0105.99.10, 0105.99.30.

Shared description:

For the purpose of the ASEAN subheadings under heading 01.05, the term “breeding” refers to live poultry of a kind presented for raising as a breeding animal.

## 0105.12.10 — BREEDING

Grouped HS code set: 0105.11.10, 0105.12.10, 0105.13.10, 0105.14.10, 0105.15.10, 0105.94.10, 0105.99.10, 0105.99.30.

Shared description:

For the purpose of the ASEAN subheadings under heading 01.05, the term “breeding” refers to live poultry of a kind presented for raising as a breeding animal.
```

Normal single-code sections do not receive `Shared description:` and remain unchanged.

## Run Parse + Image Export

```bash
npm run parse -- data/uploads/Chapter12.pdf --ocr-lang vie --docling-threads 4 --export-assets
```

Output thêm:

```text
data/converted/assets/<file>/*.png
```

Markdown sẽ có image links local:

```md
![caption](assets/<file>/<image-id>.png)
<!-- image-id: block_id -->
*Caption: caption*
```

## Run Parse + Image Export + PageIndex

```bash
npm run parse -- data/uploads/Chapter12.pdf --ocr-lang vie --docling-threads 4 --export-assets --upload-pageindex
```

Output thêm:

```text
data/converted/<file>.tree.json
data/converted/<file>.tree.validation.json
```

Nếu thiếu key, CLI báo:

```text
PAGEINDEX_API_KEY is missing. Create .env at project root or pass --pageindex-api-key.
```

## Run Multi-PDF Batch

Put PDFs in `data/uploads/`, then run:

```bash
npm run parse -- data/uploads --batch --ocr-lang vie --docling-threads 4 --export-assets --upload-pageindex
```

Batch mode processes PDFs sequentially and keeps the existing single-file parser behavior for each document. It writes:

```text
data/converted/batch.manifest.json
data/converted/all.sections.json
data/converted/all.documents.json
```

`all.sections.json` merges section records from every parsed document and is the planned Milestone 3 input for Q&A across all documents.

Non-HS reference documents, such as `Introduction.pdf`, are classified as `non-hs-reference`. They can still be uploaded to PageIndex and validated for tree structure, but the validator does not require HS sections in `sections.json`.

Recent validated batch command:

```bash
npm run parse -- data/uploads --batch --ocr-lang vie --docling-threads 4 --export-assets --upload-pageindex
```

Expected result:

```text
[Batch Summary]
Documents: 16/16 passed
```

## Start UI

```bash
npm run dev
```

Mở:

```text
http://localhost:3000
```

## UI Workflow

1. Upload one or more PDFs.
2. Chọn OCR language, mặc định `vie`.
3. Chọn Docling threads, mặc định `4`.
4. Tick `Export image assets` nếu cần ảnh.
5. Tick `Upload to PageIndex` nếu cần tree.
6. Optional: tick `Stop on first failure`; files run sequentially by default.
7. Bấm `Run Pipeline`.
8. Watch the top progress bar, current file, current step, elapsed time, per-file mini progress, and live logs.

The UI uses a two-panel debugger layout:

- Left panel shows the original uploaded PDF using `/api/uploads/<filename>`.
- Right panel shows parsed Markdown, rendered Markdown, sections, tree JSON, validation markers, and exported assets.
- Clicking a section row selects the parsed HS section, shows its page range/source/text preview, and navigates the PDF preview to `#page=<pageStart>` when the browser PDF viewer supports it.
- The batch result table is shown even for one PDF. Clicking a document row loads that document's PDF and output bundle into the two-panel viewer.

UI job có hard timeout mặc định 10 phút (`UI_PIPELINE_TIMEOUT_MS=600000`). Nếu quá hạn, server kill process tree, đánh dấu job failed và ghi debug log vào `data/tmp/`.

## Demo Flow Cho Final Submission

1. Show `.env` tồn tại nhưng che API key.
2. Run `npm run typecheck`.
3. Run `npm test`.
4. Run pipeline với `--export-assets --upload-pageindex`.
5. Show Markdown headings đúng, including grouped HS sections with `Grouped HS code set` and `Shared description`.
6. Show image links và PNG assets.
7. Show validation markers.
8. Show `tree.json`, `tree.validation.json`, `sections.json`.
9. Nói rõ Q&A nằm ở Milestone 3.

## Flow Tổng

```text
PDF
 ↓
Milestone 1: Markdown + Blocks + Validation
 ↓
Milestone 1.1: Local image assets
 ↓
Milestone 2: PageIndex Tree JSON + Section Map
 ↓
Milestone sau: RAG / Agentic Q&A
```

## Công Nghệ Chính

- **TypeScript/Node.js**: CLI, orchestration, reconstruction, validation, UI server.
- **PyMuPDF**: đọc layout PDF và crop ảnh theo `bbox`.
- **PyMuPDF4LLM**: parse nhanh trang text đơn giản.
- **Docling**: parse trang có bảng, ảnh, scan hoặc layout khó.
- **PageIndex API**: sinh Tree Index từ Markdown sạch.
- **Express + static HTML/JS/CSS**: UI demo local.
- **Vitest**: regression tests.

## Troubleshooting

- `npm not recognized`: cài Node.js rồi mở terminal mới.
- Venv chưa activate: chạy `.venv\Scripts\activate` trên Windows hoặc `source .venv/bin/activate` trên macOS/Linux.
- PyMuPDF/Docling install error: kiểm tra Python 3.10+ và thử update `pip`.
- Unicode errors on Windows Python stdout/stderr: pipeline sets `PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1`; if running Python helpers manually, keep UTF-8 enabled.
- `PAGEINDEX_API_KEY is missing`: tạo `.env` ở project root hoặc truyền `--pageindex-api-key`.
- PageIndex polling timeout: tăng `PAGEINDEX_POLL_MAX_ATTEMPTS` hoặc kiểm tra dashboard PageIndex.
- UI job chạy quá lâu: kiểm tra `data/tmp/*.ui-job-*.json`; job runner sẽ kill process sau `UI_PIPELINE_TIMEOUT_MS`.
- Markdown image links không hiện trong cloud: asset path hiện là local; milestone sau có thể dùng Base64 hoặc static hosting.
- Validation failed: xem debug ở `data/tmp/*.milestone1-failed.*` hoặc `data/tmp/*.pageindex-*.json`.
- Marker 5 failures include `layoutHSCodeCount`, `pairedHSCodeCount`, `unpairedHsCodes`, and nearest text context for each unpaired code.
- Marker 10 does not fail non-HS reference documents solely because they have zero HS sections.
