import { describe, expect, it } from "vitest";
import { countWords, TokenValidator } from "../src/validators/tokenValidator";

describe("TokenValidator", () => {
  it("passes Marker 12 when context is within budget", () => {
    const marker = TokenValidator.validateContextSize("short context", { maxChars: 20 });

    expect(marker.passed).toBe(true);
    expect(marker.marker).toBe("MARKER 12");
  });

  it("throws Marker 12 when context exceeds budget", () => {
    expect(() => TokenValidator.validateContextSize("too long", { maxChars: 3 })).toThrow("Marker 12 Failed");
  });

  it("returns Marker 13 warning instead of throwing for long answers", () => {
    const marker = TokenValidator.validateOutputSize("one two three four", { maxWords: 3 });

    expect(marker.passed).toBe(false);
    expect(marker.message).toContain("Marker 13 Warning");
  });

  it("counts whitespace-separated words", () => {
    expect(countWords("  one\n two\tthree  ")).toBe(3);
  });
});
