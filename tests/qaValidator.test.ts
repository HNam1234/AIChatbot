import { describe, expect, it } from "vitest";
import { extractInlineCitations, QAValidator } from "../src/validators/qaValidator";

describe("QAValidator", () => {
  it("passes Marker 11 when inline citations are present", () => {
    const report = QAValidator.validateResponse("Use 0704.90.10 <doc=Chapter12.pdf;page=4>.");

    expect(report.passed).toBe(true);
    expect(report.markers[0]?.marker).toBe("MARKER 11");
    expect(report.markers[0]?.details?.citationCount).toBe(1);
  });

  it("fails Marker 11 when citations are required and absent", () => {
    const report = QAValidator.validateResponse("Use 0704.90.10.");

    expect(report.passed).toBe(false);
    expect(report.errors[0]).toContain("Marker 11 Failed");
  });

  it("extracts multiple PageIndex citation tags", () => {
    expect(extractInlineCitations("A <doc=a.pdf;page=1> B <doc=b.pdf;page=2>")).toEqual([
      "<doc=a.pdf;page=1>",
      "<doc=b.pdf;page=2>"
    ]);
  });
});
