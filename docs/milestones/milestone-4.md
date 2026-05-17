# Milestone 4: MCP Agent and Round-Robin LLM Keys

[Trước: Milestone 3](milestone-3.md) | [Mục lục](../../README.md) | [Tiếp theo: Milestone 5](milestone-5.md)

Milestone 4 là custom agent dùng PageIndex MCP để lấy targeted context, sau đó dùng Gemini Round-Robin để synthesize answer. Mục tiêu là giảm input token, tăng khả năng chịu lỗi key/quota, nhưng vẫn giữ answer đủ chi tiết.

## Mục Tiêu

- Không nhồi full PDF/Markdown vào LLM.
- Dùng PageIndex MCP tool để lấy đúng section/node cần trả lời.
- Dùng nhiều Gemini key slots để failover khi một key quota/ban/permission lỗi.
- Cho phép trả lời có giải thích ngắn, không ép 15 từ.
- Dùng Marker 12/13 để kiểm token budget và output size.

## Flow Vận Hành

```text
User question
 ↓
PageIndex MCP client connect
 ↓
Select tree/search/content tool
 ↓
Retrieve targeted context
 ↓
Marker 12 kiểm context size
 ↓
GeminiRoundRobinClient synthesize answer
 ↓
Marker 13 kiểm answer length
 ↓
Return answer + retrieval metadata
```

## Module Chính

- `src/agent/mcpClient.ts`: kết nối PageIndex MCP bằng Streamable HTTP.
- `src/agent/geminiClient.ts`: Gemini Round-Robin, retry/failover, prompt rules.
- `src/agent/hsCodeAgent.ts`: orchestrate MCP retrieval + LLM synthesis.
- `src/validators/tokenValidator.ts`: Marker 12 và Marker 13.
- `src/mainFlow.ts`: entry point `--mode agent`.

## Cài Key

`.env`:

```env
PAGEINDEX_API_KEY=your_pageindex_key
PAGEINDEX_MCP_URL=https://api.pageindex.ai/mcp

GEMINI_KEY_1=your_first_key
GEMINI_KEY_1_ENABLED=true
GEMINI_KEY_2=your_second_key
GEMINI_KEY_2_ENABLED=true
GEMINI_KEY_3=your_third_key
GEMINI_KEY_3_ENABLED=false

GEMINI_API_KEY=legacy_single_key_optional
```

UI API Settings cũng cho:

- sửa từng Gemini key slot,
- bật/tắt slot bị ban,
- dùng temporary key cho một run,
- lưu key vào `.env` mà không lộ raw key.

## Round-Robin Behavior

Client load các key đang enabled theo thứ tự:

```text
GEMINI_KEY_1 → GEMINI_KEY_2 → GEMINI_KEY_3 → GEMINI_API_KEY
```

Khi gặp lỗi retryable như quota, 429, 5xx, permission denied, invalid key, forbidden hoặc banned, client bỏ qua key hiện tại và thử key kế tiếp. Raw key không được log.

## Cách Chạy

```bash
npm run agent -- --doc-name "Chapter12.milestone1.md" --query "Find the HS Code for round cabbage"
```

Có thể ép tool MCP nếu cần debug:

```bash
npm run agent -- --doc-name "Chapter12.milestone1.md" --query "Find round cabbage" --mcp-tool pageindex_tree_search
```

## Marker 12 Và Marker 13

Marker 12:

- hard gate trước khi gọi LLM,
- fail nếu targeted context vượt budget cấu hình,
- bảo vệ khỏi việc vô tình gửi toàn bộ document.

Marker 13:

- warning nếu answer quá dài,
- không chặn answer hợp lệ,
- dùng để siết prompt khi LLM bắt đầu nói lan man.

## Prompt Rules

Gemini prompt phải:

- dùng metadata/citation nếu có,
- không invent HS Code,
- không chọn contrast baseline product bằng keyword đơn thuần,
- ưu tiên numeric range, physical traits, usage/function,
- trả lời bằng ngữ cảnh retrieved, không suy diễn ngoài tài liệu.

## Quan Hệ Với Milestone 3

Milestone 3 là Q&A trên cached PageIndex tree và metadata local, phù hợp UI hỏi across all PDFs. Milestone 4 là agent MCP chi phí thấp hơn cho targeted retrieval. Hai flow dùng chung nguyên tắc citation/metadata, nhưng entry point và retrieval tool khác nhau.

## Debug

Log nên có:

```text
selected MCP tool
context chars
truncated yes/no
Gemini key slot index
retry/failover count
answer word count
```

Không log API keys, headers hoặc raw environment values.
