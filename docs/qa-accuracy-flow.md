# QA Accuracy-First Flow

Mục tiêu của `qaMode: "accuracy"` là tối ưu độ đúng cho nhóm câu HS/classification, đặc biệt bộ gộp `qa-hard-40` và 26 câu thực tế. Target vận hành là khoảng 95%, nghĩa là nếu đủ 66 câu thì cần tối thiểu 63 câu đúng. Không claim đạt target này cho tới khi fixture 26 câu có đầy đủ question + expected answer.

## Vấn đề flow cũ

Flow cũ ưu tiên tiết kiệm latency/cost:

- Query expansion dễ timeout vì timeout thấp.
- Một số câu final answer có `llmCalled=false`, nên không có bước LLM quyết định khi retrieval có nhiều candidate gần nhau.
- Rerank chỉ thực tế chạy trong một số cấu hình/provider, dẫn tới candidate score cao nhưng sai intent vẫn lọt top.
- Numeric evidence hoặc alias yếu có thể reject candidate đúng khi query là mô tả gián tiếp.

## Flow mới trong accuracy mode

Pipeline tuyến tính:

1. Normalize query và detect intent.
2. Query expansion bằng LLM, timeout 12s, retry 1 lần với compact prompt.
3. Nếu expansion vẫn fail, không abort answer. Retrieval chạy tiếp bằng query gốc và debug ghi lỗi.
4. Retrieval từ cached PageIndex tree hoặc local sections.
5. Deterministic validation tạo candidate list, strong/weak/missing evidence.
6. LLM rerank cho mọi câu HS/classification có từ 2 candidate hợp lệ.
7. Risk verifier chỉ chạy khi candidate rủi ro.
8. Final answer cho HS/classification dùng deterministic template trên candidate đã rerank/verify.
9. Citation/hyperlink/source flow hiện tại được giữ nguyên.

## Accuracy policy

`qaMode: "fast"` giữ behavior cũ để không phá use case tiết kiệm.

`qaMode: "accuracy"` bật các policy sau:

- `ENABLE_LLM_QA` hiệu lực mặc định là `true`.
- Query expansion luôn enabled, provider mặc định lấy từ env; nếu env là `none` thì dùng `openai`.
- Query expansion timeout mặc định `12000ms`.
- Query expansion retry `1` lần bằng prompt ngắn hơn.
- Rerank dùng `createLlmClient()` theo provider đang config, không hard-code Bifrost-only.
- Verifier retry `1` lần nếu timeout/error.
- Nếu verifier fail:
  - top candidate validation mạnh thì dùng deterministic top;
  - validation không mạnh thì trả clarification thay vì tự tin trả bừa.

## Risk verifier triggers

Verifier chỉ gọi khi có ít nhất một risk:

- Top margin thấp.
- Top validation không phải `high`.
- Có weak signals hoặc missing evidence.
- Rerank đổi top candidate.
- Có numeric evidence yếu hoặc candidate từng bị reject vì numeric evidence.
- Nhiều candidate cùng prefix HS gần nhau.

Verifier JSON contract:

```json
{
  "decision": "accept|switch|clarify",
  "selectedHsCode": "1000.00.00|null",
  "confidence": "high|medium|low",
  "reason": "short reason"
}
```

`switch` chỉ được accept nếu `selectedHsCode` nằm trong candidate list.

## Recommended config

```env
ENABLE_LLM_QA=true
ENABLE_LLM_QUERY_EXPANSION=true
QUERY_EXPANSION_PROVIDER=openai
QUERY_EXPANSION_TIMEOUT_MS=12000
QUERY_EXPANSION_CACHE_ENABLED=true
```

Latency kỳ vọng cho accuracy mode: khoảng 10-20s/câu khi verifier phải chạy.

## Eval

Chạy hard fixture:

```bash
npm run eval:qa -- --fixture tests/fixtures/qa-hard-40.json --qa-mode accuracy
```

Chạy real fixture sau khi điền đủ 26 câu:

```bash
npm run eval:qa -- --fixture tests/fixtures/qa-real-26.json --qa-mode accuracy
```

Script nhanh:

```bash
npm run eval:qa:accuracy
```

Runner report:

- Pass rate.
- LLM coverage.
- Rerank count.
- Verifier count.
- Timeout count.

## Debug fields

Các field cần đọc khi debug accuracy:

- `qaMode`
- `debug.queryExpansion.retryCount`
- `debug.queryExpansion.error`
- `debug.queryExpansion.timedOut`
- `debug.queryExpansionRetryCount`
- `debug.queryExpansionError`
- `debug.llmRerankCalled`
- `debug.llmRerankAccepted`
- `debug.llmRerankChangedTop`
- `debug.llmRerankSelectedHsCode`
- `debug.llmVerifierCalled`
- `debug.llmVerifierDecision`
- `debug.llmVerifierSelectedHsCode`
- `debug.llmVerifierRiskReasons`
- `debug.llmVerifierRetryCount`

## Fixture status

`tests/fixtures/qa-real-26.json` hiện là scaffold từ các câu thực tế đã biết. Cần bổ sung đủ 26 câu và expected answer/HS code trước khi dùng nó để claim target 95%.
