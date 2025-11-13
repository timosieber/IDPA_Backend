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
    const systemPrompt = [
      `Du bist der persönliche Assistent "${chatbot.name}".`,
      chatbot.description ?? "",
      "Nutze ausschließlich die bereitgestellten Kontext-Informationen. Wenn Informationen fehlen, sage offen, dass du es nicht weißt.",
    ]
      .filter(Boolean)
      .join("\n");

    if (!this.client) {
      logger.warn("OPENAI_API_KEY nicht gesetzt – Mock-Antwort wird erzeugt");
      const snippet = context.slice(0, 2).join(" ").slice(0, 280);
      return `(${chatbot.name}) Ich habe deine Frage verstanden: "${question}".\n\nKontextauszug: ${snippet || "Kein Kontext verfügbar."}`;
    }

    const completion = await this.client.chat.completions.create({
      model: chatbot.model || env.OPENAI_COMPLETIONS_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        ...context.map((c) => ({ role: "system" as const, content: `Kontext: ${c}` })),
        ...messages,
        { role: "user", content: question },
      ],
      temperature: 0.2,
      stream: false,
    });

    return completion.choices[0]?.message?.content?.trim() ?? "Ich konnte keine Antwort generieren.";
  }
}

export const llmService = new LlmService();
