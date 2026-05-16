# Milestone 1.1: Image Asset Export

Mục tiêu của Milestone 1.1 là xuất ảnh nội dung thật từ PDF thành PNG local và thay placeholder ảnh trong Markdown bằng image link local.

## Flow Chính

```text
Parsed blocks
 ↓
ArtifactFilter loại decorative images
 ↓
ImageAssetExporter crop ảnh theo bbox
 ↓
HSCodeReconstructor render ![caption](asset_path)
 ↓
MarkdownValidator Marker 9
```

## Module Chính

- `ImageAssetExporter`: dùng PyMuPDF crop image block theo `bbox`.
- `HSCodeReconstructor`: render image block thành Markdown image link khi có `assetPath`.
- `MarkdownValidator`: Marker 9 kiểm local image link có tồn tại và image block có metadata asset.

## Output

```text
data/converted/assets/<pdf-name>/<image-id>.png
```

Markdown output:

```md
![caption](assets/<pdf-name>/<image-id>.png)
<!-- image-id: block_id -->
*Caption: caption*
```

## Lệnh Chạy

```bash
npm run parse -- data/uploads/Chapter12.pdf --ocr-lang vie --docling-threads 4 --export-assets
```

## Đã Đạt

- Chapter 12 export 19 ảnh nội dung.
- Chapter 7 export 24 ảnh nội dung.
- 0 decorative full-page background images được export.
- Marker 9 pass cho image asset links.

## Lưu Ý Asset Path

Image links hiện là local paths trong `data/converted/assets`. Nếu PageIndex cloud không truy cập được local asset paths, hướng sau này là embed Base64 hoặc upload assets lên public/static storage. Milestone này chưa implement Base64/S3 để giữ pipeline đơn giản.

## Vì Sao Dùng PyMuPDF Crop

Image block đã có `pageNumber`, `bbox` và `id` từ layout layer. Crop trực tiếp bằng PyMuPDF ổn định hơn việc trích raw embedded image vì PDF có thể chứa mask, reuse xref hoặc ảnh bị cắt theo viewport.
