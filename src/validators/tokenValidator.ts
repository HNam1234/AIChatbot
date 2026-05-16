import type { ValidationMarkerResult } from "../types";

export interface ContextSizeValidationOptions {
  maxChars?: number;
  originalLength?: number;
  truncated?: boolean;
}

export interface OutputSizeValidationOptions {
  maxWords?: number;
}

export class TokenValidator {
  public static validateContextSize(
    context: string,
    options: ContextSizeValidationOptions = {}
  ): ValidationMarkerResult {
    const maxChars = options.maxChars ?? 1500;
    const passed = context.length <= maxChars;
    const message = passed
      ? `[Marker 12 Passed] Targeted context is ${context.length} chars.`
      : `[Marker 12 Failed] Context too large: ${context.length} chars; expected <= ${maxChars}.`;

    const marker: ValidationMarkerResult = {
      marker: "MARKER 12",
      passed,
      message,
      details: {
        contextLength: context.length,
        maxChars,
        originalLength: options.originalLength ?? context.length,
        truncated: options.truncated ?? false
      }
    };

    if (!passed) {
      throw new Error(message);
    }

    return marker;
  }

  public static validateOutputSize(
    answer: string,
    options: OutputSizeValidationOptions = {}
  ): ValidationMarkerResult {
    const maxWords = options.maxWords ?? 120;
    const wordCount = countWords(answer);
    const passed = wordCount <= maxWords;
    const message = passed
      ? `[Marker 13 Passed] Answer is ${wordCount} words.`
      : `[Marker 13 Warning] Answer has ${wordCount} words; expected <= ${maxWords}.`;

    return {
      marker: "MARKER 13",
      passed,
      message,
      details: {
        wordCount,
        maxWords
      }
    };
  }
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
