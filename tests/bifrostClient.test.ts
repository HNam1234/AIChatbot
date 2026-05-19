import { describe, expect, it } from "vitest";
import { BifrostApiError, BifrostClient, isRetryableBifrostError } from "../src/agent/bifrostClient";

describe("BifrostClient", () => {
  it("sends OpenAI-compatible chat completion requests", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = new BifrostClient({
      apiKey: "bifrost-key",
      baseUrl: "https://bifrost.company.com/v1/",
      model: "gpt-5.5",
      fetcher: async (input, init) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>
        });
        return new Response(JSON.stringify({
          choices: [{ message: { content: " {\"intent\":\"selected_section_qa\"} " } }]
        }), { status: 200 });
      }
    });

    const answer = await client.planQuery("Plan this query", { temperature: 0, maxOutputTokens: 384 });

    expect(answer).toBe("{\"intent\":\"selected_section_qa\"}");
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://bifrost.company.com/v1/chat/completions");
    expect(requests[0].body).toMatchObject({
      model: "gpt-5.5",
      temperature: 0,
      max_tokens: 384,
      response_format: { type: "json_object" }
    });
  });

  it("retries retryable Bifrost responses", async () => {
    let calls = 0;
    const client = new BifrostClient({
      apiKey: "bifrost-key",
      baseUrl: "https://bifrost.company.com/v1",
      model: "gpt-5.5",
      maxRetries: 1,
      fetcher: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "retry ok" } }] }), { status: 200 });
      }
    });

    await expect(client.planQuery("Plan this query")).resolves.toBe("retry ok");
    expect(calls).toBe(2);
  });

  it("marks only 429 and 5xx Bifrost errors as retryable", () => {
    expect(isRetryableBifrostError(new BifrostApiError("limited", 429))).toBe(true);
    expect(isRetryableBifrostError(new BifrostApiError("server", 503))).toBe(true);
    expect(isRetryableBifrostError(new BifrostApiError("bad request", 400))).toBe(false);
  });
});
