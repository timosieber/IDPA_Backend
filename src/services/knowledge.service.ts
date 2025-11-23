import crypto from "node:crypto";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { env } from "../config/env.js";
import { getVectorStore } from "./vector-store/index.js";

export interface IngestionInput {
  content: string; // Markdown
  metadata: {
    chatbotId?: string;
    knowledgeSourceId?: string;
    sourceUrl?: string;
    filename?: string;
    title: string;
    datePublished?: string;
    type: "web" | "pdf";
  };
}

interface EnrichedChunk {
  combined: string;
  original: string;
  summary: string;
  index: number;
}

const SUMMARY_PROMPT = (title: string, chunk: string) =>
  `Du bist ein AI-Assistent. Hier ist ein Ausschnitt aus dem Dokument "${title}". Bitte fasse den Inhalt in einem einzigen, prägnanten Satz zusammen, der den Kontext für eine Suchmaschine klärt.\n\nAusschnitt:\n${chunk}`;

const DEFAULT_SUMMARIZER_MODEL = "gpt-4o-mini";
const MAX_CONCURRENCY = 10;
const USE_MOCK_LLM = process.env.MOCK_LLM === "1" || process.env.OFFLINE_MODE === "1";

export class KnowledgeService {
  private readonly vectorStore = getVectorStore();
  private readonly embeddings = new OpenAIEmbeddings({
    model: env.OPENAI_EMBEDDINGS_MODEL,
  });
  private readonly summarizer = new ChatOpenAI({
    model: env.OPENAI_COMPLETIONS_MODEL || DEFAULT_SUMMARIZER_MODEL,
    temperature: 0.1,
  });

  async processIngestion(input: IngestionInput) {
    if (!input.content?.trim()) {
      throw new Error("IngestionInput.content darf nicht leer sein");
    }
    if (!input.metadata?.title) {
      throw new Error("IngestionInput.metadata.title ist erforderlich");
    }

    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1200,
      chunkOverlap: 200,
      separators: ["\n# ", "\n## ", "\n### ", "\n#### ", "\n\n", "\n", " "],
    });

    const chunks = await splitter.splitText(input.content);
    if (!chunks.length) {
      throw new Error("Keine Chunks generiert – Eingabe zu kurz?");
    }

    const enriched = await this.summarizeChunks(chunks, input.metadata.title);
    await this.embedAndStore(enriched, input.metadata);

    return { chunks: enriched.length };
  }

  private async summarizeChunks(chunks: string[], title: string): Promise<EnrichedChunk[]> {
    const results: EnrichedChunk[] = new Array(chunks.length);
    let cursor = 0;

    const workers = Array(Math.min(MAX_CONCURRENCY, chunks.length))
      .fill(null)
      .map(async () => {
        while (true) {
          const index = cursor;
          cursor += 1;
          if (index >= chunks.length) break;
          const chunk = chunks[index]!;
          const summary = await this.generateSummary(title, chunk);
          const combined = `[Kontext: ${summary}]\n\n${chunk}`;
          results[index] = { combined, original: chunk, summary, index };
        }
      });

    await Promise.all(workers);
    return results;
  }

  private async generateSummary(title: string, chunk: string): Promise<string> {
    if (USE_MOCK_LLM || !env.OPENAI_API_KEY) {
      return (chunk.slice(0, 180) || "Kontext").replace(/\s+/g, " ").trim();
    }
    try {
      const res = await this.summarizer.invoke([
        { role: "user", content: SUMMARY_PROMPT(title, chunk) },
      ]);
      const text = typeof res.content === "string"
        ? res.content
        : Array.isArray(res.content)
          ? res.content.map((c: any) => ("text" in c ? c.text : c)).join(" ")
          : "";
      return (text || "").trim() || "Zusammenfassung nicht verfügbar";
    } catch (error) {
      return "Zusammenfassung nicht verfügbar";
    }
  }

  private async embedAndStore(chunks: EnrichedChunk[], metadata: IngestionInput["metadata"]) {
    let cursor = 0;
    const workers = Array(Math.min(MAX_CONCURRENCY, chunks.length))
      .fill(null)
      .map(async () => {
        while (true) {
          const idx = cursor;
          cursor += 1;
          if (idx >= chunks.length) break;
          const chunk = chunks[idx]!;
          const vector = await this.embedSafe(chunk.combined);
          const enrichedMetadata = {
            chatbotId: metadata.chatbotId ?? "global",
            knowledgeSourceId: metadata.knowledgeSourceId ?? metadata.sourceUrl ?? metadata.filename ?? "unknown",
            title: metadata.title,
            sourceUrl: metadata.sourceUrl,
            filename: metadata.filename,
            datePublished: metadata.datePublished,
            type: metadata.type,
            chunkIndex: chunk.index,
            original_content: chunk.original,
          };

          await this.vectorStore.upsertEmbedding({
            vector,
            metadata: enrichedMetadata,
            content: chunk.combined,
          });
        }
      });

    await Promise.all(workers);
  }

  private async embedSafe(text: string): Promise<number[]> {
    if (USE_MOCK_LLM || !env.OPENAI_API_KEY) {
      return this.mockEmbedding(text);
    }
    try {
      return await this.embeddings.embedQuery(text);
    } catch {
      return this.mockEmbedding(text);
    }
  }

  private mockEmbedding(text: string): number[] {
    const hash = crypto.createHash("sha256").update(text).digest();
    return Array.from(hash).map((byte) => (byte / 255) * 2 - 1);
  }
}

export const knowledgeService = new KnowledgeService();
