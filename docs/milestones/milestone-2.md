# Milestone 2: PageIndex Tree Generation

Mục tiêu của Milestone 2 là upload Markdown sạch từ Milestone 1/1.1 lên PageIndex để sinh Tree JSON. Pipeline không tự build vector database/chunking thủ công ở local; thay vào đó upload Markdown sạch lên PageIndex để PageIndex sinh Tree Index.

## Flow Chính

```text
Milestone 1 Markdown
 ↓
PageIndexClient upload /markdown/
 ↓
TreeBuilder lấy structure hoặc polling doc_id
 ↓
TreeValidator Marker 10
 ↓
data/converted/<file>.tree.json
data/converted/<file>.tree.validation.json
data/converted/<file>.sections.json
```

## Module Chính

- `pageindexClient.ts`: HTTP client gọi PageIndex API.
- `treeBuilder.ts`: upload Markdown, nhận tree trực tiếp hoặc polling khi API trả `doc_id`.
- `treeValidator.ts`: Marker 10 kiểm tree khớp Markdown headings.
- `sectionMapBuilder.ts`: tạo local citation map để giữ document/page/HS/source mapping.
- `mainFlow.ts`: nối Milestone 2 sau khi Milestone 1 validation pass.

## API Dùng

- `POST https://api.pageindex.ai/markdown/`
- Optional form fields:
  - `if_add_node_id=yes`
  - `if_add_node_summary=yes`
  - `if_add_node_text=yes`
- Fallback polling nếu có `doc_id`:
  - `GET https://api.pageindex.ai/doc/{doc_id}/?type=tree&summary=true`

## Output

```text
data/converted/<file>.tree.json
data/converted/<file>.tree.validation.json
data/converted/<file>.sections.json
```

## Lệnh Chạy

Tạo `.env`:

```text
PAGEINDEX_API_KEY=your_pageindex_api_key_here
```

Chạy:

```bash
npm run parse -- data/uploads/Chapter12.pdf --ocr-lang vie --docling-threads 4 --export-assets --upload-pageindex
```

## Marker 10

Tree phải đạt các điều kiện:

- Có node tương ứng với heading `#` và `##` trong Markdown.
- Có đủ HS code nodes so với Markdown.
- Node có `node_id`.
- Node có summary.
- Số lượng tree nodes không thấp hơn số heading cần reconcile.
- Section map tồn tại và chứa đủ HS codes.
- Nếu page range thiếu, validator report warning thay vì block pipeline.

## Polling Timeout

Polling dùng:

```text
PAGEINDEX_POLL_INTERVAL_MS=5000
PAGEINDEX_POLL_MAX_ATTEMPTS=60
```

Nếu timeout hoặc PageIndex trả failed, pipeline ghi response cuối vào `data/tmp/<file>.pageindex-timeout.<timestamp>.json` hoặc `data/tmp/<file>.pageindex-failed.<timestamp>.json`.

## Vì Sao Upload Markdown

PDF đã được Milestone 1 làm sạch và reconstruct theo rule HS Code. Upload Markdown vào `/markdown/` giúp PageIndex build tree từ cấu trúc đã chuẩn, thay vì để PageIndex parse lại PDF từ đầu và có nguy cơ lệch layout.
