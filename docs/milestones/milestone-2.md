# Milestone 2: PageIndex Tree Generation

[Trước: Milestone 1.1](milestone-1-1.md) | [Mục lục](../../README.md) | [Tiếp theo: Milestone 3](milestone-3.md)

Milestone 2 upload Markdown sạch từ Milestone 1/1.1 lên PageIndex để sinh Tree Index. Pipeline không tự build vector database local.

## Mục Tiêu

- Dùng Markdown đã reconstruct làm nguồn duy nhất để PageIndex build tree.
- Lưu lại `docId`, tree payload và raw response vào local cache.
- Tạo `sections.json` để map HS code/title/page/source/caption cho citation.
- Reuse tree cache để không upload/generate lại nếu đã có tree.
- Validate tree bằng Marker 10.

## Flow Vận Hành

```text
Milestone 1 Markdown
 ↓
SectionMapBuilder tạo sections.json từ Markdown + blocks metadata
 ↓
PageIndexClient upload Markdown
 ↓
TreeBuilder nhận tree trực tiếp hoặc poll theo doc_id
 ↓
TreeValidator Marker 10
 ↓
Ghi tree cache và validation report
```

## Module Chính

- `src/api/pageindexClient.ts`: HTTP client PageIndex.
- `src/pageindex/treeBuilder.ts`: upload/poll/reuse cached tree.
- `src/pageindex/treeValidator.ts`: Marker 10.
- `src/pageindex/sectionMapBuilder.ts`: local section metadata cho Q&A.
- `src/mainFlow.ts`: nối Milestone 2 vào parse flow.

## Cách Chạy

```bash
npm run parse -- data/uploads/Chapter12.pdf --ocr-lang vie --docling-threads 4 --export-assets --upload-pageindex
```

Output:

```text
data/converted/Chapter12.tree.json
data/converted/Chapter12.tree.validation.json
data/converted/Chapter12.sections.json
```

## Cache PageIndex Tree

`--upload-pageindex` không có nghĩa là luôn upload lại. Pipeline sẽ reuse:

```text
data/converted/<file>.tree.json
```

khi file cache có `docId` và tree payload. Nếu Markdown hash khác, validator ghi warning nhưng vẫn reuse tree để tránh tốn công generate lại.

Chỉ force regenerate khi thật sự cần:

```bash
npm run parse -- data/uploads/Chapter12.pdf --ocr-lang vie --docling-threads 4 --export-assets --upload-pageindex --force-pageindex-upload
```

## Batch

```bash
npm run parse -- data/uploads --batch --ocr-lang vie --docling-threads 4 --export-assets --upload-pageindex
```

Batch output:

```text
data/converted/batch.manifest.json
data/converted/all.sections.json
data/converted/all.documents.json
```

`all.sections.json` là nguồn join metadata chính cho Milestone 3 Q&A across all PDFs.

## Marker 10

Tree pass khi:

- Có node tương ứng với Markdown headings.
- Có đủ HS section nodes so với Markdown/section map.
- Node có `node_id` nếu PageIndex trả về.
- Node có summary/text nếu request bật tương ứng.
- Section map hợp lệ với HS code, title, document, page/source nếu có.

Non-HS reference document như `Introduction.pdf` được classify `non-hs-reference`; validator không fail chỉ vì có zero HS sections.

## API Dùng

Upload Markdown:

```text
POST https://api.pageindex.ai/markdown/
```

Polling tree nếu API trả `doc_id`:

```text
GET https://api.pageindex.ai/doc/{doc_id}/?type=tree&summary=true
```

## Debug

Nếu timeout/fail:

```text
data/tmp/<file>.pageindex-timeout.<timestamp>.json
data/tmp/<file>.pageindex-failed.<timestamp>.json
```

Nếu không muốn generate lại tree, giữ nguyên `data/converted/<file>.tree.json` và không dùng `--force-pageindex-upload`.
