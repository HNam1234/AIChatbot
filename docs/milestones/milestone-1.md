# Milestone 1: Local PDF Parser

Mục tiêu của Milestone 1 là biến PDF HS Code thành Markdown ổn định để PageIndex có thể đọc đúng cấu trúc `CHAPTER` và HS sections. Giai đoạn này chạy local, không gọi LLM/API.

## Flow Chính

```text
PDF
 ↓
LayoutAnalyzer
 ↓
SmartRouter
 ↓
ArtifactFilter
 ↓
SemanticFusion
 ↓
HSCodeReconstructor
 ↓
MarkdownValidator
```

## Module Chính

- `LayoutAnalyzer`: dùng PyMuPDF đọc text, image, table, drawing và tọa độ layout.
- `SmartRouter`: trang dễ dùng PyMuPDF4LLM, trang phức tạp dùng Docling.
- `ArtifactFilter`: loại watermark, logo, icon nhỏ, background toàn trang.
- `SemanticFusion`: gắn image với caption/source gần nhất, tránh over-fusion.
- `HSCodeReconstructor`: dựng Markdown từ layout blocks, không dùng raw Markdown của parser.
- `MarkdownValidator`: kiểm Marker 1-8 cho header, table, caption và HS title.

## Output

```text
data/converted/<file>.milestone1.md
data/converted/<file>.milestone1.blocks.json
data/converted/<file>.milestone1.validation.json
```

## Lệnh Chạy

```bash
npm run parse -- data/uploads/Chapter12.pdf --ocr-lang vie --docling-threads 4
```

## Đã Đạt

- Chapter H1 được giữ đúng.
- Thứ tự HS code được giữ theo layout gốc.
- HS title pairing pass cho Chapter 7 và Chapter 12.
- Source lines không bị gộp nhầm vào caption.
- Missing HS sections được phát hiện bằng validator.
- Table reconstruction hiện còn giới hạn; một số table phức tạp có thể được flatten thành text/list, miễn HS title pairing vẫn đúng.

## Vì Sao Dùng Cách Này

Docling/PyMuPDF raw Markdown có thể sai reading order hoặc gộp block nhầm. Vì vậy pipeline chỉ dùng parser để lấy layout blocks, sau đó tự reconstruct Markdown bằng rule HS Code để kiểm soát cấu trúc ngữ nghĩa.
