# HSCode PDF Parser + PageIndex Agent

Repo này là pipeline TypeScript để parse tài liệu PDF mã HS thành Markdown sạch, export ảnh thật, sinh PageIndex Tree Index, rồi hỏi đáp trên toàn bộ bộ tài liệu bằng retrieval có citation.

File này đóng vai trò như mục lục và hướng dẫn chạy nhanh. Chi tiết thiết kế, flow và vận hành của từng phần nằm trong các README milestone bên dưới.

## Mục Lục

Đọc theo thứ tự như một quyển sách:

1. [Milestone 1: Local PDF Parser](docs/milestones/milestone-1.md)
2. [Milestone 1.1: Image Asset Export](docs/milestones/milestone-1-1.md)
3. [Milestone 2: PageIndex Tree Generation](docs/milestones/milestone-2.md)
4. [Milestone 3: Agentic Q&A and Reasoning Retrieval](docs/milestones/milestone-3.md)
5. [Milestone 4: MCP Agent and Round-Robin LLM Keys](docs/milestones/milestone-4.md)
6. [Milestone 5: Spatial Grounding and BBox Mapping](docs/milestones/milestone-5.md)

## Flow Tổng

```text
PDF
 ↓
Milestone 1: Markdown + blocks.json + validation
 ↓
Milestone 1.1: crop ảnh nội dung thành local assets
 ↓
Milestone 2: upload Markdown lên PageIndex + cache tree JSON
 ↓
Milestone 3: Q&A trên tất cả cached PageIndex trees + citation card
 ↓
Milestone 4: MCP targeted retrieval + Gemini Round-Robin failover
 ↓
Milestone 5: click PDF ↔ bbox block ↔ Markdown anchor
```

## Cấu Trúc Repo

```text
src/
├── agent/                  # Q&A formatter, Gemini Round-Robin, MCP agent
├── api/                    # PageIndex client, chat session
├── cli/                    # Chat REPL
├── config/                 # .env parsing, API key settings
├── layout/                 # PDF layout analysis
├── orchestrator/           # parse flow, reconstruction, fusion, asset export
├── pageindex/              # tree build/validation, section map
├── server/                 # local UI backend
├── ui/                     # local browser UI
├── utils/                  # path/process helpers
└── validators/             # Marker validators

docs/milestones/            # milestone docs, đọc theo mục lục ở trên
data/uploads/               # PDF input local, gitignored
data/converted/             # Markdown/tree/sections/assets output, gitignored
data/tmp/                   # debug logs, gitignored
tests/                      # Vitest regressions
```

## Yêu Cầu Môi Trường

- Node.js 18+
- Python 3.10+
- Git
- PageIndex API key nếu chạy upload/tree hoặc PageIndex chat
- Gemini API key nếu dùng Milestone 3/4 answer synthesis

## Cài Đặt

Windows PowerShell:

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

## Cấu Hình `.env`

Tạo `.env` từ `.env.example`. Không commit `.env`.

```env
PAGEINDEX_API_KEY=your_pageindex_key
PAGEINDEX_API_BASE_URL=https://api.pageindex.ai
PAGEINDEX_MCP_URL=https://api.pageindex.ai/mcp

GEMINI_KEY_1=your_first_gemini_key
GEMINI_KEY_1_ENABLED=true
GEMINI_KEY_2=your_second_gemini_key
GEMINI_KEY_2_ENABLED=true
GEMINI_KEY_3=your_third_gemini_key
GEMINI_KEY_3_ENABLED=true

PORT=3000
UI_PIPELINE_TIMEOUT_MS=600000
```

UI cũng có panel API Settings để lưu PageIndex key và bật/tắt từng Gemini key slot. Raw key không được trả về frontend, không log ra terminal.

## Lệnh Build Và Kiểm Tra

```bash
npm run typecheck
npm test
npm run build
```

## Chạy Parser Một PDF

Parse Markdown + validation:

```bash
npm run parse -- data/uploads/Chapter12.pdf --ocr-lang vie --docling-threads 4
```

Parse + export ảnh:

```bash
npm run parse -- data/uploads/Chapter12.pdf --ocr-lang vie --docling-threads 4 --export-assets
```

Parse + export ảnh + upload PageIndex:

```bash
npm run parse -- data/uploads/Chapter12.pdf --ocr-lang vie --docling-threads 4 --export-assets --upload-pageindex
```

Mặc định `--upload-pageindex` sẽ reuse `data/converted/<file>.tree.json` nếu cache đã có `docId` và tree payload. Chỉ dùng `--force-pageindex-upload` khi thật sự muốn generate lại PageIndex tree.

## Chạy Batch Nhiều PDF

Đặt PDF vào `data/uploads/`, sau đó chạy:

```bash
npm run parse -- data/uploads --batch --ocr-lang vie --docling-threads 4 --export-assets --upload-pageindex
```

Batch output chính:

```text
data/converted/batch.manifest.json
data/converted/all.sections.json
data/converted/all.documents.json
```

`all.sections.json` là nguồn metadata quan trọng cho Q&A/citation across documents.

## Chạy Local UI

```bash
npm run dev
```

Mở:

```text
http://localhost:3000
```

`npm run dev` chạy server ổn định, phù hợp upload PDF lớn. `npm run dev:watch` chỉ nên dùng khi đang sửa code và không upload file lớn.

## UI Workflow

1. Mở `http://localhost:3000`.
2. Cấu hình PageIndex/Gemini keys nếu cần.
3. Upload một hoặc nhiều PDF.
4. Chọn OCR language, Docling threads, export assets, upload PageIndex.
5. Giữ `Reuse cached PageIndex tree` bật để không generate lại tree.
6. Bấm `Run Pipeline`.
7. Theo dõi progress bar, per-file status, live logs.
8. Dùng Agent Console để hỏi trên tất cả cached PageIndex trees.

## Chạy Q&A

Hỏi qua CLI với một hoặc nhiều `doc_id`:

```bash
npm run chat -- --doc-id "doc_id_from_milestone_2" --query "Oxen là gì?"
```

Hỏi qua UI trên toàn bộ cached trees:

```text
Agent Console → Scope: All cached PageIndex documents → Ask
```

Milestone 3 ưu tiên PageIndex/cached tree retrieval trước. BM25 chỉ là fallback khi PageIndex không có usable HS section metadata.

## Chạy MCP Agent

```bash
npm run agent -- --doc-name "Chapter12.milestone1.md" --query "Find the HS Code for round cabbage"
```

Milestone 4 dùng PageIndex MCP để lấy targeted context, rồi Gemini Round-Robin để synthesize answer. Có thể bật/tắt từng `GEMINI_KEY_N_ENABLED` trong `.env` hoặc UI.

## Output Chính

```text
data/converted/<file>.milestone1.md
data/converted/<file>.milestone1.blocks.json
data/converted/<file>.milestone1.validation.json
data/converted/<file>.sections.json
data/converted/<file>.tree.json
data/converted/<file>.tree.validation.json
data/converted/assets/<file>/*.png
```

## Troubleshooting Nhanh

- `PAGEINDEX_API_KEY is missing`: tạo `.env` hoặc nhập key trong UI.
- PageIndex bị generate lại: giữ `<file>.tree.json`, bật `Reuse cached PageIndex tree`, không dùng `--force-pageindex-upload`.
- Upload bị `Request aborted`: giữ tab mở trong lúc upload, kiểm tra file quá lớn hoặc mạng local bị ngắt; UI có upload progress để trace.
- Python Unicode lỗi Windows: pipeline set `PYTHONIOENCODING=utf-8` và `PYTHONUTF8=1`.
- Q&A thiếu HS Code: kiểm tra `sections.json` / `all.sections.json`; answer layer sẽ repair từ metadata nếu section có HS code.
- Gemini key bị ban/quota: bỏ tick key slot đó trong UI hoặc set `GEMINI_KEY_N_ENABLED=false`.

## Demo Checklist

```bash
npm run typecheck
npm test
npm run build
npm run parse -- data/uploads --batch --ocr-lang vie --docling-threads 4 --export-assets --upload-pageindex
```

Sau đó mở UI, kiểm tra Markdown, sections, tree JSON, assets, validation markers và Agent Console.
