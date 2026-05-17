# Milestone 5: Spatial Grounding and BBox Mapping

[Trước: Milestone 4](milestone-4.md) | [Mục lục](../../README.md)

Milestone 5 là tính năng verify hai chiều giữa PDF gốc và output parse. Người dùng click vào vùng trên PDF, UI tìm block tương ứng trong `blocks.json` rồi scroll/highlight Markdown. Chiều ngược lại, click Markdown sẽ nhảy về trang PDF và vẽ bbox overlay.

Tính năng này không cần LLM token vì toàn bộ dữ liệu tọa độ đã có từ Milestone 1.

## Mục Tiêu

- Đối chiếu nhanh PDF gốc với Markdown/section đã parse.
- Dùng `blockId`, `pageNumber`, `bbox` trong `*.milestone1.blocks.json`.
- Cho phép click PDF → highlight Markdown.
- Cho phép click Markdown/section → navigate PDF + highlight bbox.
- Không ảnh hưởng parser core hoặc PageIndex tree generation.

## Flow 3 Chiều

```text
Click tọa độ X/Y trên PDF
 ↓
Tìm block trong blocks.json theo page + bbox
 ↓
Scroll tới Markdown anchor / section tương ứng
```

Chiều ngược:

```text
Click Markdown block
 ↓
Đọc data-page + data-bbox
 ↓
PDF viewer chuyển trang và vẽ overlay bbox
```

## Data Contract

Mỗi block cần có tối thiểu:

```json
{
  "id": "block_15",
  "pageNumber": 3,
  "bbox": [72.1, 120.4, 486.8, 168.2],
  "type": "text",
  "content": "..."
}
```

Nếu block là image/table/caption/source, vẫn giữ `id`, `pageNumber`, `bbox` để UI highlight đúng vùng gốc.

## Markdown Anchor Contract

Frontend cần một anchor ổn định cho mỗi block hoặc mỗi rendered section. Có hai hướng:

1. Render anchor trong UI từ `blocks.json` mà không sửa Markdown file.
2. Hoặc nhúng HTML anchor vào Markdown khi cần export/debug:

```md
<div id="block_15" data-page="3" data-bbox="72.1,120.4,486.8,168.2">

Parsed text...

</div>
```

Ưu tiên hướng 1 nếu không muốn làm nhiễu Markdown gửi lên PageIndex. Chỉ dùng hướng 2 cho debug view hoặc export nội bộ.

## Frontend Flow

PDF panel:

1. Render PDF bằng browser PDF viewer, `pdf.js`, hoặc `react-pdf`.
2. Bắt click trên page container.
3. Convert client coordinate sang PDF coordinate theo scale hiện tại.
4. Tìm block match:

```ts
const matchedBlock = blocks.find((block) => {
  if (block.pageNumber !== pageNumber) return false;
  const [x0, y0, x1, y1] = block.bbox;
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
});
```

5. Emit `selectedBlockId`.

Markdown panel:

1. Tìm DOM node theo `data-block-id` hoặc `id`.
2. `scrollIntoView({ behavior: "smooth", block: "center" })`.
3. Add class highlight tạm thời.

## CSS Highlight

```css
.grounded-block-highlight {
  background: rgba(255, 235, 59, 0.45);
  border-left: 4px solid #ff9800;
  transition: background-color 180ms ease;
}

.pdf-bbox-highlight {
  position: absolute;
  border: 2px solid #d97706;
  background: rgba(217, 119, 6, 0.16);
  pointer-events: none;
}
```

## Edge Cases

- PDF coordinate origin có thể khác DOM coordinate; cần normalize theo viewer scale và page rotation.
- Một click có thể nằm trong nhiều bbox; chọn bbox nhỏ nhất hoặc block có center gần click nhất.
- Bảng lớn nên highlight cả table block, không từng cell nếu chưa có cell-level bbox.
- Image caption có thể ở block khác image; UI nên show relation nếu `captionLinked` có trong metadata.
- Nếu Markdown đã group nhiều blocks thành một HS section, vẫn nên giữ block-level anchors trong rendered debug view.

## Acceptance Criteria

- Click PDF text block scroll tới đúng parsed Markdown block.
- Click Markdown block chuyển PDF tới đúng page.
- UI vẽ bbox overlay đúng scale.
- Không gọi LLM/API cho spatial grounding.
- Không làm thay đổi output PageIndex tree trừ khi explicitly bật debug anchors.
