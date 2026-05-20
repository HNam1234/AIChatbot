import type { PageIndexJson } from "./types";

export function extractChatAnswer(payload: PageIndexJson): string {
  const choices = payload.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as { message?: { content?: unknown }; text?: unknown };
    const content = first.message?.content ?? first.text;
    if (typeof content === "string") {
      return content.trim();
    }
  }

  const directChoice = choices as { message?: { content?: unknown } } | undefined;
  if (typeof directChoice?.message?.content === "string") {
    return directChoice.message.content.trim();
  }

  if (typeof payload.content === "string") {
    return payload.content.trim();
  }

  throw new Error("[PageIndex Chat] Response does not contain choices[0].message.content.");
}
