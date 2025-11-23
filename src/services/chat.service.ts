import crypto from "node:crypto";
import type { Chatbot, Message, Session } from "@prisma/client";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { env } from "../config/env.js";
import { getVectorStore } from "./vector-store/index.js";
import { messageService } from "./message.service.js";
import { BadRequestError } from "../utils/errors.js";
import { prisma } from "../lib/prisma.js";

// Debug hook to trace module load issues in ESM/ts-node
console.log("[chat.service] module init");

type SessionWithChatbot = Session & { chatbot: Chatbot };

interface RankedContext {
  id: string;
  content: string;
  metadata: Record<string, any>;
  score: number;
}

const RERANK_PROMPT = (query: string, docs: RankedContext[]) => {
  const docsText = docs
    .map((d, idx) => `ID: ${idx + 1}\nText: ${d.content.slice(0, 1200)}\nMeta: ${JSON.stringify(d.metadata)}`)
    .join("\n\n");
  return `Du bist ein Re-Ranker. Sortiere die folgenden Passagen nach Relevanz zur Anfrage und gib NUR die IDs als kommaseparierte Liste, ohne weitere Worte.\n\nAnfrage: ${query}\n\nPassagen:\n${docsText}\n\nAntwortformat: "3,1,2"`;
};

const USE_MOCK_LLM = process.env.MOCK_LLM === "1" || process.env.OFFLINE_MODE === "1";
const PINECONE_DIMENSION_FALLBACK = 1024;
const DEFAULT_CHAT_MODEL = "gpt-5.1";

export class ChatService {
  private readonly vectorStore = getVectorStore();
  private readonly embeddings = new OpenAIEmbeddings({
    model: env.OPENAI_EMBEDDINGS_MODEL,
  });
  private readonly rerankModel = new ChatOpenAI({
    model: env.OPENAI_COMPLETIONS_MODEL || DEFAULT_CHAT_MODEL,
    temperature: 0,
  });

  async handleMessage(session: SessionWithChatbot, content: string) {
    if (!content?.trim()) {
      throw new BadRequestError("Message darf nicht leer sein");
    }

    const history = await messageService.getRecentMessages(session.id);
    await messageService.logMessage(session.id, "user", content);

    const bot = await this.getChatbot(session.chatbotId);

    // Stage 1: Vector search
    const queryVector = await this.embedSafe(content);
    const vectorMatches = await this.vectorStore.similaritySearch({
      chatbotId: session.chatbotId,
      vector: queryVector,
      topK: 20,
    });

    // Stage 2: Re-rank (LLM-based fallback)
    const reranked = await this.rerank(content, vectorMatches);
    const topContexts = reranked.slice(0, 5);

    const contextString = this.buildContextString(topContexts);
    const citations = this.buildCitations(topContexts);

    const systemPrompt = bot.systemPrompt
      ? bot.systemPrompt
      : [
          `Du bist ein Assistent für ${bot.name || "unser Projekt"}.`,
          bot.description ?? "",
          "Antworte NUR basierend auf dem folgenden Kontext.",
          "Wenn die Antwort nicht im Kontext steht, sage 'Ich weiß es nicht'.",
          "Zitiere deine Quellen am Ende der Antwort im Format: [Titel](URL).",
        ].join(" ");

    const chatModel = new ChatOpenAI({
      model: bot.model || env.OPENAI_COMPLETIONS_MODEL || DEFAULT_CHAT_MODEL,
      temperature: 0.2,
    });

    const messages = [
      { role: "system" as const, content: systemPrompt },
      ...history.map((m: Message) => ({
        role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content: m.content,
      })),
      {
        role: "user" as const,
        content: `Frage: ${content}\n\nKontext:\n${contextString}`,
      },
    ];

    let answer: string;
    if (USE_MOCK_LLM || !env.OPENAI_API_KEY) {
      const snippet = topContexts[0]?.content?.slice(0, 200) ?? "Keine Daten";
      answer = `Mock-Antwort (offline). Relevanter Kontext: ${snippet}`;
    } else {
    const completion = await chatModel.invoke(messages);
      answer = typeof completion.content === "string"
        ? completion.content
        : Array.isArray(completion.content)
          ? completion.content.map((c: any) => ("text" in c ? c.text : c)).join(" ")
          : "";
    }

    if (!answer.includes("[") && citations) {
      answer = `${answer}\n\nQuellen: ${citations}`;
    } else if (citations && !answer.includes(citations)) {
      answer = `${answer}\n\nQuellen: ${citations}`;
    }

    await messageService.logMessage(session.id, "assistant", answer);

    return {
      answer,
      context: topContexts.map((c) => c.content),
      sources: topContexts.map((c) => ({ content: c.content, metadata: c.metadata, score: c.score })),
    };
  }

  /**
   * Lightweight helper for tests or ad-hoc calls without Session/DB.
   */
  async generateResponse({
    chatbotId,
    message,
    history = [],
  }: {
    chatbotId: string;
    message: string;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
  }) {
    const bot = await this.getChatbot(chatbotId);

    const queryVector = await this.embedSafe(message);
    const vectorMatches = await this.vectorStore.similaritySearch({
      chatbotId,
      vector: queryVector,
      topK: 20,
    });
    const reranked = await this.rerank(message, vectorMatches);
    const topContexts = reranked.slice(0, 5);

    const contextString = this.buildContextString(topContexts);
    const citations = this.buildCitations(topContexts);

    const systemPrompt = bot.systemPrompt
      ? bot.systemPrompt
      : [
          `Du bist ein Assistent für ${bot.name || "unser Projekt"}.`,
          bot.description ?? "",
          "Antworte NUR basierend auf dem folgenden Kontext.",
          "Wenn die Antwort nicht im Kontext steht, sage 'Ich weiß es nicht'.",
          "Zitiere deine Quellen am Ende der Antwort im Format: [Titel](URL).",
        ].join(" ");

    const chatModel = new ChatOpenAI({
      model: bot.model || env.OPENAI_COMPLETIONS_MODEL || DEFAULT_CHAT_MODEL,
      temperature: 0.2,
    });

    const messages = [
      { role: "system" as const, content: systemPrompt },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: `Frage: ${message}\n\nKontext:\n${contextString}` },
    ];

    let answer: string;
    if (USE_MOCK_LLM || !env.OPENAI_API_KEY) {
      const snippet = topContexts[0]?.content?.slice(0, 200) ?? "Keine Daten";
      answer = `Mock-Antwort (offline). Relevanter Kontext: ${snippet}`;
    } else {
      const completion = await chatModel.invoke(messages);
      answer = typeof completion.content === "string"
        ? completion.content
        : Array.isArray(completion.content)
          ? completion.content.map((c: any) => ("text" in c ? c.text : c)).join(" ")
          : "";
    }

    if (!answer.includes("[") && citations) {
      answer = `${answer}\n\nQuellen: ${citations}`;
    } else if (citations && !answer.includes(citations)) {
      answer = `${answer}\n\nQuellen: ${citations}`;
    }

    return {
      answer,
      context: topContexts.map((c) => c.content),
      sources: topContexts.map((c) => ({ content: c.content, metadata: c.metadata, score: c.score })),
    };
  }

  private async rerank(query: string, docs: Array<{ id: string; content: string; metadata: Record<string, any>; score: number }>): Promise<RankedContext[]> {
    if (!docs.length) return [];
    if (USE_MOCK_LLM || !env.OPENAI_API_KEY) {
      return docs.slice(0, 5).map((d, i) => ({
        id: d.id || `unknown-${i}`,
        content: d.content,
        metadata: d.metadata,
        score: d.score,
      }));
    }
    try {
      const prompt = RERANK_PROMPT(query, docs.map((d) => ({ ...d })));
      const res = await this.rerankModel.invoke([{ role: "user", content: prompt }]);
      const text = typeof res.content === "string"
        ? res.content
        : Array.isArray(res.content)
          ? res.content.map((c: any) => ("text" in c ? c.text : c)).join(" ")
          : "";
      const ids = text
        .split(/[, ]+/)
        .map((v) => parseInt(v, 10))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= docs.length);

      if (!ids.length) return docs.slice(0, 5);

      const ordered: RankedContext[] = [];
      ids.forEach((idx, i) => {
        const d = docs[idx - 1];
        if (!d) return;
        ordered.push({
          id: d.id || `unknown-${Math.random().toString(36).substring(7)}`,
          content: d.content,
          metadata: d.metadata,
          score: docs.length - i,
        });
      });

      return ordered;
    } catch {
      return docs.map((d, i) => ({
        id: d.id || `unknown-${Math.random().toString(36).substring(7)}`,
        content: d.content,
        metadata: d.metadata,
        score: d.score ?? docs.length - i,
      }));
    }
  }

  private buildContextString(contexts: RankedContext[]): string {
    return contexts
      .map((ctx, i) => {
        const meta = ctx.metadata || {};
        const title = meta.title || meta.label || meta.filename || meta.sourceUrl || `Quelle ${i + 1}`;
        const url = meta.sourceUrl || meta.filename || "N/A";
        const date = meta.datePublished ? ` (Datum: ${meta.datePublished})` : "";
        return `### ${title}${date}\nURL: ${url}\n${ctx.content}`;
      })
      .join("\n\n");
  }

  private buildCitations(contexts: RankedContext[]): string {
    if (!contexts.length) return "";
    const parts = contexts.map((ctx, i) => {
      const meta = ctx.metadata || {};
      const title = meta.title || meta.label || meta.filename || `Quelle ${i + 1}`;
      const url = meta.sourceUrl || meta.filename || "N/A";
      return `[${title}](${url})`;
    });
    return Array.from(new Set(parts)).join(" ");
  }

  private async embedSafe(text: string): Promise<number[]> {
    if (USE_MOCK_LLM || !env.OPENAI_API_KEY) {
      return this.normalizeVector(this.mockEmbedding(text));
    }
    try {
      const vec = await this.embeddings.embedQuery(text);
      return this.normalizeVector(vec);
    } catch {
      return this.normalizeVector(this.mockEmbedding(text));
    }
  }

  private mockEmbedding(text: string): number[] {
    const hash = crypto.createHash("sha256").update(text).digest();
    return Array.from(hash).map((byte) => (byte / 255) * 2 - 1);
  }

  private normalizeVector(vec: number[]): number[] {
    if (env.VECTOR_DB_PROVIDER === "pinecone" && vec.length > PINECONE_DIMENSION_FALLBACK) {
      return vec.slice(0, PINECONE_DIMENSION_FALLBACK);
    }
    return vec;
  }

  private async getChatbot(chatbotId: string): Promise<{ id: string; name: string; description: string | null; systemPrompt: string | null; model: string | null }> {
    const bot = await prisma.chatbot.findUnique({ where: { id: chatbotId } }).catch(() => null);
    if (!bot) {
      return {
        id: chatbotId,
        name: "RAG Assistant",
        description: "Fallback Bot",
        systemPrompt: null,
        model: env.OPENAI_COMPLETIONS_MODEL || DEFAULT_CHAT_MODEL,
      };
    }
    return {
      id: bot.id,
      name: bot.name,
      description: bot.description ?? null,
      systemPrompt: bot.systemPrompt as any as string | null ?? null,
      model: bot.model ?? env.OPENAI_COMPLETIONS_MODEL ?? DEFAULT_CHAT_MODEL,
    };
  }
}

export const chatService = new ChatService();
