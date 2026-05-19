import { describe, expect, it } from "vitest";
import { extractRequestedField } from "../src/agent/fieldExtractor";

describe("fieldExtractor", () => {
  const sectionText = [
    "General requirements on appearance:",
    "The fish body is balanced, fins are complete and normal, and there are no visible wounds.",
    "",
    "Activeness:",
    "The fish swim actively and respond normally to external movement.",
    "",
    "Weight and size:",
    "The lot has uniform size and the required weight range for stocking."
  ].join("\n");

  it("extracts appearance requirements by heading", () => {
    const result = extractRequestedField(sectionText, "appearance requirements");

    expect(result.confidence).toBe("high");
    expect(result.fallbackUsed).toBe(false);
    expect(result.matchedHeading).toBe("General requirements on appearance");
    expect(result.extractedText).toContain("body is balanced");
    expect(result.extractedText).not.toContain("swim actively");
  });

  it("extracts activeness by heading", () => {
    const result = extractRequestedField(sectionText, "activeness");

    expect(result.confidence).toBe("high");
    expect(result.matchedHeading).toBe("Activeness");
    expect(result.extractedText).toContain("swim actively");
    expect(result.extractedText).not.toContain("required weight");
  });

  it("extracts the following bullet under matched Activeness heading", () => {
    const result = extractRequestedField([
      "Activeness",
      "- The fish must swim actively and respond to touch.",
      "",
      "Weight and size",
      "- Uniform lot size."
    ].join("\n"), "activeness");

    expect(result.confidence).toBe("high");
    expect(result.fallbackUsed).toBe(false);
    expect(result.matchedHeading).toBe("Activeness");
    expect(result.extractedText).toContain("swim actively");
    expect(result.extractedText).not.toContain("Uniform lot size");
  });

  it("splits inline field labels even when the section text already has newlines", () => {
    const result = extractRequestedField([
      "## CHAPTER 3",
      "Breeding fish are accompanied by certification from the competent authorities.",
      "General requirements on appearance: Well-proportioned body and normal fins. Activeness: Fish should be active, swift, swimming under the water in groups. Weight and size: Depends on each species and hatchery time."
    ].join("\n"), "activeness");

    expect(result.confidence).toBe("high");
    expect(result.matchedHeading).toBe("Activeness");
    expect(result.extractedText).toContain("active, swift");
    expect(result.extractedText).not.toContain("Weight and size");
  });

  it("extracts weight and size by heading", () => {
    const result = extractRequestedField(sectionText, "trọng lượng và kích thước");

    expect(result.confidence).toBe("high");
    expect(result.matchedHeading).toBe("Weight and size");
    expect(result.extractedText).toContain("uniform size");
  });

  it("returns low confidence when the requested field is missing", () => {
    const result = extractRequestedField("Usage:\nUsed for stocking ponds.", "appearance requirements");

    expect(result.confidence).toBe("low");
    expect(result.extractedText).toBe("");
  });
});
