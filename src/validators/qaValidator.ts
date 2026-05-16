import type { ValidationReport } from "../types";

export interface QAValidationOptions {
  requireCitations?: boolean;
}

export class QAValidator {
  public static validateResponse(answer: string, options: QAValidationOptions = {}): ValidationReport {
    const requireCitations = options.requireCitations ?? true;
    const citations = extractInlineCitations(answer);
    const passed = !requireCitations || citations.length > 0;
    const message = passed
      ? `[Marker 11 Passed] Citation integrity check found ${citations.length} inline citation(s).`
      : "[Marker 11 Failed] Missing citations: answer does not contain inline PageIndex citations.";

    return {
      passed,
      errors: passed ? [] : [message],
      markers: [
        {
          marker: "MARKER 11",
          passed,
          message,
          details: {
            citationCount: citations.length,
            citations,
            requireCitations
          }
        }
      ]
    };
  }

  public static assertValidResponse(answer: string, options: QAValidationOptions = {}): ValidationReport {
    const report = QAValidator.validateResponse(answer, options);
    if (!report.passed) {
      throw new Error(report.errors.join("; "));
    }

    return report;
  }
}

export function extractInlineCitations(answer: string): string[] {
  return Array.from(answer.matchAll(/<doc=[^>]+>/gi), (match) => match[0]);
}
