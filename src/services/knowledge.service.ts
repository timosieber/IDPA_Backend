import crypto from "node:crypto";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { env } from "../config/env.js";
import { getVectorStore } from "./vector-store/index.js";
import { scraperRunner } from "./scraper/index.js";
import type { ScrapeOptions, DatasetItem } from "./scraper/types.js";
import { prisma } from "../lib/prisma.js";
import { promptGeneratorService } from "./prompt-generator.service.js";

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
const PINECONE_DIMENSION_FALLBACK = 1024;

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

  // Compatibility wrappers for legacy callers
  async listSources(_userId?: string, _chatbotId?: string) {
    if (!_chatbotId) return [];
    return prisma.knowledgeSource.findMany({
      where: { chatbotId: _chatbotId },
      orderBy: { createdAt: "desc" },
      include: { embeddings: true },
    });
  }

  async deleteSource(_userId?: string, _id?: string) {
    if (!_id) return true;
    const source = await prisma.knowledgeSource.findUnique({ where: { id: _id } });
    if (source) {
      await this.vectorStore.deleteByKnowledgeSource({ chatbotId: source.chatbotId, knowledgeSourceId: source.id });
      await this.vectorStore.deleteByChatbot({ chatbotId: source.chatbotId });
      await prisma.knowledgeSource.delete({ where: { id: source.id } });
    }
    return true;
  }

  async addTextSource(_userIdOrTitle: string, _chatbotIdOrContent: string, label?: string, content?: string) {
    const title = label ?? _chatbotIdOrContent;
    const body = content ?? _chatbotIdOrContent;
    const markdown = `# ${title}\n\n${content}`;
    const chatbotId = typeof _chatbotIdOrContent === "string" ? _chatbotIdOrContent : "default-bot";
    const source = await this.upsertKnowledgeSource({
      chatbotId,
      label: title,
      uri: null,
      type: "TEXT",
      metadata: {},
    });
    await this.processIngestion({
      content: markdown,
      metadata: {
        title,
        type: "web",
        chatbotId,
        knowledgeSourceId: source.id,
      },
    });
    await prisma.knowledgeSource.update({ where: { id: source.id }, data: { status: "READY" } });
    return source;
  }

  async scrapeAndIngest(_userId: string, _chatbotId: string, scrapeOptionsOrUrl: any) {
    const opts: ScrapeOptions =
      typeof scrapeOptionsOrUrl === "string"
        ? { startUrls: [scrapeOptionsOrUrl] }
        : scrapeOptionsOrUrl || {};

    const cleanedStartUrls = (opts.startUrls || []).filter((u) => typeof u === "string" && u.trim().length > 0);
    opts.startUrls = cleanedStartUrls;

    if (!opts.startUrls || !opts.startUrls.length) {
      throw new Error("URL fehlt für scrapeAndIngest");
    }
    const firstUrl = opts.startUrls[0] ?? "unknown-url";

    const pages: DatasetItem[] = await scraperRunner.run(opts);
    let ingested = 0;

    // Versuche System Prompt aus gescrapten Seiten zu generieren
    try {
      const generatedPrompt = await promptGeneratorService.generateSystemPrompt(pages as any);
      await prisma.chatbot.update({
        where: { id: _chatbotId },
        data: { systemPrompt: generatedPrompt },
      });
    } catch (err) {
      console.error("System Prompt Generierung fehlgeschlagen", err);
    }

    for (const page of pages) {
      const title = page.title || page.canonical_url || page.page_url;
      const pageText = page.main_text || (page as any).text || (page as any).content || JSON.stringify(page, null, 2);
      const markdown = `# ${title}\n\n${pageText}`;
      if (!markdown.trim()) continue;

      const source = await this.upsertKnowledgeSource({
        chatbotId: _chatbotId || "default-bot",
        label: title,
        uri: page.canonical_url || page.page_url,
        type: "URL",
        metadata: { fetchedAt: page.fetched_at, meta: page.meta, lang: page.lang },
      });

      await this.processIngestion({
        content: markdown,
        metadata: {
          chatbotId: _chatbotId || "default-bot",
          knowledgeSourceId: source.id,
          title,
          sourceUrl: page.canonical_url || page.page_url,
          datePublished: page.fetched_at,
          type: "web",
        },
      });
      ingested += 1;
    }

    if (!ingested) {
      await this.processIngestion({
        content: `# ${firstUrl}\n\nKeine verwertbaren Inhalte gefunden.`,
        metadata: {
          chatbotId: _chatbotId || "default-bot",
          title: firstUrl,
          sourceUrl: firstUrl,
          type: "web",
        },
      });
      ingested = 1;
    }

    return { sources: [{ id: "scrape", label: firstUrl, chunks: ingested }], pagesScanned: pages.length };
  }

  private async upsertKnowledgeSource({
    chatbotId,
    label,
    uri,
    type,
    metadata,
  }: {
    chatbotId: string;
    label: string;
    uri: string | null;
    type: "URL" | "TEXT" | "FILE";
    metadata: Record<string, any>;
  }) {
    const existing = uri
      ? await prisma.knowledgeSource.findFirst({ where: { chatbotId, uri } })
      : null;
    if (existing) {
      return prisma.knowledgeSource.update({
        where: { id: existing.id },
        data: { label, metadata, status: "READY" },
      });
    }
    return prisma.knowledgeSource.create({
      data: {
        chatbotId,
        label,
        uri,
        type,
        metadata,
        status: "READY",
      },
    });
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
          const vector = this.normalizeVector(await this.embedSafe(chunk.combined));
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

  private normalizeVector(vector: number[]): number[] {
    if (env.VECTOR_DB_PROVIDER === "pinecone" && vector.length > PINECONE_DIMENSION_FALLBACK) {
      return vector.slice(0, PINECONE_DIMENSION_FALLBACK);
    }
    return vector;
  }

  async purgeChatbotVectors(chatbotId: string) {
    try {
      await this.vectorStore.deleteByChatbot({ chatbotId });
    } catch (err) {
      // swallow, log if needed
      console.error("purgeChatbotVectors error", err);
    }
  }
}

export const knowledgeService = new KnowledgeService();
