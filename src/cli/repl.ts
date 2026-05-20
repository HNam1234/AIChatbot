import readline from "node:readline";
import { ChatSession, PageIndexClient } from "../api";
import { QAValidator } from "../validators/qaValidator";

export interface ChatCliOptions {
  apiKey: string;
  baseUrl?: string;
  docId?: string | string[];
  temperature?: number;
  enableCitations?: boolean;
}

export async function askChatQuestion(question: string, options: ChatCliOptions): Promise<string> {
  const session = createChatSession(options);
  const turn = await session.ask(question);
  const validation = QAValidator.validateResponse(turn.answer, {
    requireCitations: options.enableCitations ?? true
  });

  console.log(turn.answer);
  console.log(validation.markers[0]?.message ?? "[Marker 11] Citation validation completed.");

  return turn.answer;
}

export async function startChatSession(options: ChatCliOptions): Promise<void> {
  const session = createChatSession(options);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log("Agentic HSCode Chat");
  if (options.docId) {
    console.log(`Document scope: ${Array.isArray(options.docId) ? options.docId.join(", ") : options.docId}`);
  }
  console.log("Type exit or quit to stop.");
  rl.setPrompt("You: ");
  rl.prompt();

  try {
    for await (const line of rl) {
      const query = line.trim();
      if (!query) {
        rl.prompt();
        continue;
      }

      if (query.toLowerCase() === "exit" || query.toLowerCase() === "quit") {
        break;
      }

      try {
        const turn = await session.ask(query);
        console.log(`\nAI:\n${turn.answer}\n`);
        const validation = QAValidator.validateResponse(turn.answer, {
          requireCitations: options.enableCitations ?? true
        });
        console.log(validation.markers[0]?.message ?? "[Marker 11] Citation validation completed.");
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }

      rl.prompt();
    }
  } finally {
    rl.close();
  }
}

function createChatSession(options: ChatCliOptions): ChatSession {
  return new ChatSession({
    client: new PageIndexClient(options.apiKey, { baseUrl: options.baseUrl }),
    docId: options.docId,
    temperature: options.temperature,
    enableCitations: options.enableCitations,
    systemPrompt: [
      "You answer questions about HS Code reference documents.",
      "Use the selected PageIndex document scope.",
      "When facts come from the document, include inline citations."
    ].join("\n")
  });
}
