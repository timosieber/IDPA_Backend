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
      ? `\n\nHier sind relevante Informationen aus meiner Wissensbasis:\n${context.map((c, i) => `${c}`).join("\n\n")}`
      : "";

    const developerInstructions = [
      `Du bist ${chatbot.name}, ein hilfreicher und freundlicher Assistent.`,
      chatbot.description ?? "",
      "",
      "Wichtige Regeln:",
      "- Antworte direkt und natürlich, als würdest du mit einem Freund sprechen",
      "- Nutze die bereitgestellten Informationen aus der Wissensbasis, um präzise zu antworten",
      "- Antworte immer auf Deutsch in einem professionellen aber freundlichen Ton",
      "- Vermeide technische Formulierungen wie 'im bereitgestellten Kontext' oder 'laut den Informationen'",
      "- Wenn du etwas nicht weißt, sage es ehrlich und unkompliziert",
      "- Gib kurze, prägnante Antworten - keine langen Erklärungen wenn nicht nötig",
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

    // Use Chat Completions API with GPT-5.1 (without reasoning.effort parameter)
    const completion = await this.client.chat.completions.create({
      model: chatbot.model || env.OPENAI_COMPLETIONS_MODEL,
      messages: inputMessages.map(msg => ({
        role: msg.role === "developer" ? "system" : msg.role,
        content: msg.content,
      })),
      max_tokens: 1000,
      stream: false,
    });

    return completion.choices[0]?.message?.content?.trim() ?? "Ich konnte keine Antwort generieren.";
  }
}

export const llmService = new LlmService();
