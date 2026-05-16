# Milestone 1: Local PDF Parser Pipeline

Pipeline TypeScript chạy cục bộ để parse PDF trước khi đưa sang PageIndex ở Milestone 2. Luồng này không gọi LLM/API token; Node.js chỉ đóng vai trò orchestrator, còn parser nặng được gọi qua CLI/Python local. Markdown cuối cùng được dựng lại từ layout blocks theo rule HS Code, không phụ thuộc vào Markdown tự sinh của Docling/PyMuPDF.

## Kiến trúc

```text
src/
├── orchestrator/
│   ├── layoutAnalyzer.ts
│   ├── router.ts
│   ├── artifactFilter.ts
│   ├── semanticFusion.ts
│   ├── hsCodeReconstructor.ts
│   └── consolidator.ts
├── tools/
│   ├── doclingWrapper.ts
│   └── pyMuPDFWrapper.ts
├── validators/
│   └── markdownValidator.ts
└── mainFlow.ts
```

## Luồng xử lý

1. **`LayoutAnalyzer`**: Dùng PyMuPDF để đọc text/image/table/drawing bounding boxes.
2. **`SmartRouter`**: Đưa trang text-only sang PyMuPDF4LLM fast mode, và đưa trang có bảng, ảnh, scan hoặc floating annotation sang Docling accurate mode.
3. **`ArtifactFilter`**: Chạy thuật toán lọc nhiễu trực quan đa tầng (multi-tiered visual noise filtering) để đánh dấu các phần tử phi thông tin:
   - Nhiễu kích thước: icon quá nhỏ.
   - Nhiễu tần suất và vị trí: logo/header/footer lặp lại cùng vị trí trên nhiều trang.
   - Nhiễu nền/toàn trang: ảnh phủ gần hết trang, thường là background scan layer.
   - Nhiễu trong suốt: ảnh có alpha/soft mask nằm ở vùng thân trang, thường là watermark.
4. **`SemanticFusion`**: Dung hợp ngữ nghĩa - không gian. Gom cụm text bằng DBSCAN nhẹ, chấm điểm khoảng cách/từ khóa/font/symbol, liên kết caption hoặc ký hiệu không gian gần ảnh hữu ích, chia sẻ caption cho các ảnh cùng cụm trực quan, đồng thời gộp các ảnh bị cắt mảnh trùng lặp. Semantic fence ngăn caption dính HS Code, source hoặc đoạn văn dài.
5. **`HSCodeReconstructor`**: Bỏ Markdown parser-driven và dựng Markdown từ layout blocks theo state machine HS Code. Module này giữ `CHAPTER` ở H1, ghép `HS Code — Title` ở H2, duy trì thứ tự đọc theo `bbox.y0/x0`, và đưa text/source/image vào đúng section hiện hành.
6. **`MarkdownValidator`**: Kiểm tra 8 marker nghiệm thu: header hierarchy, table integrity, visual-caption linkage, HS Code order, HS Code-title pairing, missing sections, source leakage và caption over-fusion.

## Cài đặt

```bash
npm install

python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS/Linux
source .venv/bin/activate

pip install pymupdf4llm docling
```

## Chạy pipeline

```bash
npm run parse -- data/uploads/input.pdf --ocr-lang vie --docling-threads 4
```

Output mặc định:

- `data/converted/<file>.milestone1.md`
- `data/converted/<file>.milestone1.blocks.json`
- `data/converted/<file>.milestone1.validation.json`

Nếu validation fail, pipeline sẽ dừng và ghi debug log vào `data/tmp/*.milestone1-failed.*`. Validation report gồm cả ID, trang, tọa độ, kích thước và `areaRatio` của các ảnh không map được caption, đồng thời ghi rõ marker semantic nào bị lệch.

## Tùy chọn CLI

```text
-o, --out <path>              Markdown output path
--blocks <path>               Parsed blocks JSON path
--validation <path>           Validation report JSON path
--python <path>               Python executable path
--docling <path>              Docling executable path
--timeout-ms <number>         Parser timeout per tool process
--docling-batch-size <number> Number of accurate pages per Docling batch
--docling-threads <number>    Docling CPU threads
--ocr-lang <lang>             OCR language, for example eng or vie
--allow-fallback              Use PyMuPDF when Docling fails
--no-header                   Do not synthesize a document H1
--page-markers                Include HTML page comments in Markdown
--noise-tolerance <number>    Pixel tolerance for watermark/logo filtering, default 50
```

## Kiểm thử

```bash
npm run typecheck
npm test
```
