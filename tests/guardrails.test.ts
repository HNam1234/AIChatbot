import { describe, expect, it } from "vitest";

import { enforceGrounding, IDK_ANSWER } from "../src/guardrails.js";

describe("enforceGrounding", () => {
  it("returns I don't know without a required citation", () => {
    expect(enforceGrounding("Revenue increased.", true)).toBe(IDK_ANSWER);
  });

  it("keeps cited answers", () => {
    const answer = "Revenue increased. <doc=report.pdf;page=4>";
    expect(enforceGrounding(answer, true)).toBe(answer);
  });

  it("allows uncited answers when configured", () => {
    expect(enforceGrounding("Short answer.", false)).toBe("Short answer.");
  });
});
