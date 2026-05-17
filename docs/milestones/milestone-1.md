# Milestone 1: Local PDF Parser

[Mục lục](../../README.md) | [Tiếp theo: Milestone 1.1](milestone-1-1.md)

Milestone 1 biến PDF HS Code thành Markdown sạch, `blocks.json` và validation report. Giai đoạn này chạy local, không gọi LLM, không upload PageIndex.

## Mục Tiêu

- Giữ đúng thứ tự đọc theo layout PDF.
- Dựng heading `# CHAPTER ...` và `## <HS Code> — <Title>` ổn định.
- Ghép đúng HS code với title, kể cả grouped HS codes.
- Loại bỏ artifact như source line, page number, caption giả, header/footer.
- Tạo `blocks.json` có text, page, bbox và metadata để dùng cho debug/spatial grounding sau này.

## Flow Vận Hành

```text
PDF
 ↓
LayoutAnalyzer lấy text/image/table/drawing blocks
 ↓
SmartRouter chọn PyMuPDF4LLM hoặc Docling theo độ phức tạp trang
 ↓
ArtifactFilter loại watermark, logo, header/footer, page number
 ↓
SemanticFusion nối caption/source/image hợp lý
 ↓
HSCodeReconstructor dựng Markdown từ blocks đã chuẩn hóa
 ↓
MarkdownValidator chạy Marker 1-8
```

## Module Chính

- `src/layout/layoutAnalyzer.ts`: đọc layout bằng PyMuPDF, giữ `pageNumber`, `bbox`, `blockId`.
- `src/orchestrator/smartRouter.ts`: route trang đơn giản/phức tạp sang parser phù hợp.
- `src/orchestrator/artifactFilter.ts`: loại block nhiễu không phải nội dung HS.
- `src/orchestrator/semanticFusion.ts`: nối caption/source gần ảnh và text đúng ngữ cảnh.
- `src/orchestrator/hsCodeReconstructor.ts`: dựng Markdown chuẩn HS section.
- `src/validators/markdownValidator.ts`: kiểm marker chất lượng Markdown.

## Cách Chạy

```bash
npm run parse -- data/uploads/Chapter12.pdf --ocr-lang vie --docling-threads 4
```

Output:

```text
data/converted/Chapter12.milestone1.md
data/converted/Chapter12.milestone1.blocks.json
data/converted/Chapter12.milestone1.validation.json
data/converted/Chapter12.sections.json
```

## Markdown Chuẩn

Single HS code:

```md
## 0102.29.11 — OXEN

Oxen are castrated adult male bovine animals.

(Source: Indonesia)
```

Grouped HS codes sharing one title:

```md
## 0105.11.10 — BREEDING

Grouped HS code set: 0105.11.10, 0105.12.10, 0105.13.10.

Shared description:

For the purpose of the ASEAN subheadings under heading 01.05, the term "breeding" refers to...

## 0105.12.10 — BREEDING

Grouped HS code set: 0105.11.10, 0105.12.10, 0105.13.10.

Shared description:

For the purpose of the ASEAN subheadings under heading 01.05, the term "breeding" refers to...
```

Mỗi grouped code có H2 riêng để search/retrieval không bị mất code đứng đầu group.

## Marker Quan Trọng

- Marker 1-4: cấu trúc Markdown, chapter heading, table/caption hygiene.
- Marker 5: HS code-title pairing.
- Marker 6-8: semantic consistency, source/caption/image safety.

Marker 5 phải report:

```text
layoutHSCodeCount
directPairCount
groupedPairCount
pairedHSCodeCount
unpairedHsCodes
```

Pipeline chỉ pass khi mọi HS code detect được đều được pair trực tiếp hoặc grouped.

## Nguyên Tắc Không Đổi

- Không tin raw Markdown của parser khi dựng final Markdown.
- Không lấy source line, picture caption, page number, table header hoặc list row làm title HS.
- Không "steal" title từ section kế tiếp.
- Không rewrite parser core khi chỉ cần sửa reconstructor/validator.

## Debug

Khi fail, xem:

```text
data/tmp/<file>.milestone1-failed.<timestamp>.md
data/tmp/<file>.milestone1-failed.<timestamp>.blocks.json
```

Nếu fail Marker 5, đọc `unpairedHsCodes` để biết HS code nào thiếu title, page/block nào, text trước/sau là gì.
