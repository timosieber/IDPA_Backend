import OpenAI from "openai";
import type { MessageRole } from "@prisma/client";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

interface ChatMessage {
  role: Exclude<MessageRole, "system"> | "system";
  content: string;
}

export interface ChatCompletionArgs {
  chatbot: { name: string; description: string | null; model: string };
  messages: ChatMessage[];
  context: string[];
  question: string;
}

class LlmService {
  private readonly client?: OpenAI;

  constructor() {
    if (env.OPENAI_API_KEY) {
      this.client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    }
  }

  async generateResponse({ chatbot, messages, context, question }: ChatCompletionArgs) {
    const contextInfo = context.length > 0
      ? `\n\nRelevanter Kontext aus der Wissensdatenbank:\n${context.map((c, i) => `[${i + 1}] ${c}`).join("\n\n")}`
      : "";

    const developerInstructions = [
      `Du bist der hilfreiche Assistent "${chatbot.name}".`,
      chatbot.description ?? "",
      "Deine Aufgabe:",
      "1. Beantworte Fragen auf Basis des bereitgestellten Kontexts präzise und hilfreich.",
      "2. Wenn der Kontext die Antwort enthält, nutze diese Informationen und verweise darauf.",
      "3. Wenn der Kontext die Antwort NICHT enthält, sage das höflich und biete an, allgemeine Informationen zu geben, falls sinnvoll.",
      "4. Sei freundlich, professionell und gehe auf die spezifische Frage ein.",
      contextInfo,
    ]
      .filter(Boolean)
      .join("\n");

    if (!this.client) {
      logger.warn("OPENAI_API_KEY nicht gesetzt – Mock-Antwort wird erzeugt");
      const snippet = context.slice(0, 2).join(" ").slice(0, 280);
      return `(${chatbot.name}) Ich habe deine Frage verstanden: "${question}".\n\nKontextauszug: ${snippet || "Kein Kontext verfügbar."}`;
    }

    // Convert messages to new Responses API format
    const inputMessages: Array<{ role: "developer" | "user" | "assistant"; content: string }> = [
      { role: "developer", content: developerInstructions },
    ];

    // Add conversation history
    for (const msg of messages) {
      if (msg.role === "user") {
        inputMessages.push({ role: "user", content: msg.content });
      } else if (msg.role === "assistant") {
        inputMessages.push({ role: "assistant", content: msg.content });
      }
    }

    // Add current question
    inputMessages.push({ role: "user", content: question });

    // Use new Responses API with GPT-5.1 parameters
    const response = await this.client.responses.create({
      model: chatbot.model || env.OPENAI_COMPLETIONS_MODEL,
      input: inputMessages,
      reasoning: { effort: "medium" }, // none, low, medium, high
      text: { verbosity: "medium" }, // low, medium, high
      max_output_tokens: 1000,
    });

    // Extract text from response output
    return response.output_text ?? "Ich konnte keine Antwort generieren.";
  }
}

export const llmService = new LlmService();
