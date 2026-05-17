# Milestone 1.1: Image Asset Export

[Trước: Milestone 1](milestone-1.md) | [Mục lục](../../README.md) | [Tiếp theo: Milestone 2](milestone-2.md)

Milestone 1.1 xuất ảnh nội dung thật từ PDF thành PNG local và thay placeholder trong Markdown bằng image link có caption/source.

## Mục Tiêu

- Crop đúng ảnh nội dung theo `bbox` từ layout layer.
- Không export decorative full-page background, icon, logo nhỏ hoặc artifact.
- Giữ caption/source đủ gần để ảnh có ngữ cảnh.
- Markdown render được ảnh local và validator kiểm được file tồn tại.

## Flow Vận Hành

```text
Milestone 1 blocks
 ↓
ArtifactFilter loại decorative image blocks
 ↓
ImageAssetExporter crop PDF page theo bbox
 ↓
HSCodeReconstructor render Markdown image link
 ↓
MarkdownValidator Marker 9
```

## Module Chính

- `src/orchestrator/imageAssetExporter.ts`: crop image block bằng PyMuPDF.
- `src/orchestrator/semanticFusion.ts`: gắn caption/source trước khi render.
- `src/orchestrator/hsCodeReconstructor.ts`: render `![caption](assets/...)`.
- `src/validators/markdownValidator.ts`: Marker 9 kiểm asset path và image metadata.

## Cách Chạy

```bash
npm run parse -- data/uploads/Chapter12.pdf --ocr-lang vie --docling-threads 4 --export-assets
```

Output thêm:

```text
data/converted/assets/Chapter12/<image-id>.png
```

Markdown:

```md
![caption](assets/Chapter12/<image-id>.png)
<!-- image-id: block_id -->
*Caption: caption*
```

## Quy Tắc Export

- Chỉ crop block ảnh có bbox hợp lệ và qua filter artifact.
- Caption/source được lấy từ block gần nhất, không gộp bừa toàn trang.
- Nếu crop fail, pipeline ghi warning/debug thay vì làm hỏng toàn bộ parse khi text vẫn hợp lệ.
- Asset path là relative path dưới `data/converted`, phù hợp UI local.

## Giới Hạn Hiện Tại

Image links hiện là local file path. Nếu cần PageIndex/cloud đọc trực tiếp ảnh, milestone sau phải upload assets lên static storage hoặc embed Base64. Milestone này cố ý giữ local để parser nhanh, rẻ và dễ debug.

## Debug

Kiểm tra:

```text
data/converted/<file>.milestone1.validation.json
data/converted/assets/<file>/
```

Marker 9 fail thường do asset file thiếu, bbox crop sai hoặc Markdown link không trỏ đúng relative path.
