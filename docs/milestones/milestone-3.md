# Milestone 3: Agentic Q&A and Reasoning Retrieval

[Trước: Milestone 2](milestone-2.md) | [Mục lục](../../README.md) | [Tiếp theo: Milestone 4](milestone-4.md)

Milestone 3 thêm lớp hỏi đáp trên PageIndex Tree Index và local section metadata. Mục tiêu là trả lời câu hỏi HS Code bằng ngôn ngữ tự nhiên nhưng luôn có HS Code và citation đầy đủ.

## Mục Tiêu

- Hỏi trên một hoặc tất cả documents đã có PageIndex tree cache.
- PageIndex/cached tree là retrieval source chính.
- BM25/local section search chỉ là fallback.
- Join retrieval hit với `sections.json` / `all.sections.json` để lấy `hsCode`, title, document, page, source.
- Không để LLM tự nhớ hoặc tự suy luận HS Code khi metadata đã có.
- UI hiển thị answer text, retrieval source và citation card.

## Flow Vận Hành

```text
User question
 ↓
Load cached tree JSON documents
 ↓
Search PageIndex tree nodes first
 ↓
Join hit với all.sections.json / sections.json
 ↓
Rank section theo metadata + contrast rules
 ↓
Build structured context cho LLM
 ↓
Gemini Round-Robin synthesize answer nếu có key
 ↓
Answer formatter repair/force HS Code + citation từ metadata
 ↓
Marker 11 citation validation + UI citation card
```

## Retrieval Strategy

Ưu tiên:

1. PageIndex/cached tree section hit.
2. Tree node title chứa HS code.
3. Tree hit join được với local section metadata.
4. BM25 fallback trên local section metadata nếu PageIndex không có usable result.

BM25 không được trộn ngang hàng với PageIndex hits. Khi fallback xảy ra, API response/UI sẽ hiện:

```json
{
  "source": "bm25-fallback",
  "bm25FallbackUsed": true
}
```

## Structured Context

LLM không nhận raw text đơn thuần. Mỗi retrieved section được truyền dạng:

```text
[SECTION 1]
- document: Chapter06.pdf
- chapter: CHAPTER 6
- pageStart: 22
- pageEnd: 22
- hsCode: 0602.90.50
- groupedHsCodes:
- title: SEEDLINGS OF THE GENUS HEVEA
- section: 0602.90.50 — SEEDLINGS OF THE GENUS HEVEA
- source: Malaysia
- captions:
- text: Seedlings of the genus Hevea are germinated rubber tree seeds...
```

Nếu `hsCode` hoặc `groupedHsCodes` có trong metadata, final answer bắt buộc chứa HS Code tương ứng.

## Answer Format

Single code:

```text
<direct answer>. HS Code: <hsCode>.

Nguồn: <document>, page <page>, section "<section>".
```

Grouped code khi trạng thái hàng hóa chưa rõ:

```text
<direct answer>. HS Code: <code1> hoặc <code2>, tùy trạng thái hàng hóa.

Nguồn: <document>, page <page>, section "<section>".
```

Nếu LLM bỏ sót code, formatter tự repair bằng metadata. Nếu LLM trả code không thuộc selected section, agent retry một lần với prompt strict hơn rồi fallback về template metadata.

## Contrast Term Rule

Các câu có cụm như:

```text
hơn X
so với X
khác với X
thay vì X
không phải X
less/more than X
compared to X
instead of X
```

thì `X` thường là baseline so sánh, không phải sản phẩm cần chọn. Ranker ưu tiên section khớp thuộc tính vật lý, numeric range, usage/function và phạt candidate chỉ match baseline trong title.

Ví dụ:

```text
Loại cà phê có vị đắng hơn Arabica và caffeine cao hơn là gì?
```

Expected target là Robusta nếu section Robusta match đầy đủ thuộc tính, không chọn Arabica chỉ vì query nhắc đến Arabica.

## CLI

Một câu hỏi:

```bash
npm run chat -- --doc-id "doc_id_from_milestone_2" --query "Seedlings of the genus Hevea được định nghĩa là gì?"
```

Interactive:

```bash
npm run chat -- --doc-id "doc_id_from_milestone_2"
```

## UI

Trong Agent Console:

- `Scope: All cached PageIndex documents` để hỏi toàn bộ PDFs đã có `*.tree.json`.
- Answer panel hiển thị answer text.
- Retrieval status hiển thị `pageindex-tree` hoặc `bm25-fallback`.
- Citation card hiển thị HS Code(s), title, document, page, section, source.
- UI vẫn hiện HS Code trong citation card ngay cả khi answer text bị LLM thiếu.

## Marker 11

Marker 11 kiểm answer có grounding/citation. Với cached-tree Q&A, citation chuẩn là dòng `Nguồn:` và metadata card, không dùng citation rút gọn kiểu `<doc=Chapter06.pdf>` làm output cuối.

## Regression Quan Trọng

- Hevea seedlings trả `0602.90.50`, `Chapter06.pdf`, page 22, section đúng.
- Oxen trả `0102.29.11`.
- Agarwood chips trả `1211.90.95`.
- Contrast query không chọn baseline product bằng keyword đơn thuần.
- Grouped HS code query trả toàn bộ grouped codes khi state chưa rõ.

## Debug Logs

Khi debug Q&A, backend log:

```text
query
PageIndex result count
BM25 fallback used
top retrieved sections
contrast terms
selected section
final HS codes
answer repair applied
```

Raw API keys không được log.
