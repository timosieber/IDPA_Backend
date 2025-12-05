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

const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_CONCURRENCY = 10;
const USE_MOCK_LLM = process.env.MOCK_LLM === "1" || process.env.OFFLINE_MODE === "1";
// Pinecone unterstützt nur bestimmte Dimensionen (384, 512, 768, 1024, 2048)
const EMBEDDING_DIMENSION = 1024;

export class KnowledgeService {
  private readonly vectorStore = getVectorStore();
  private readonly embeddings = new OpenAIEmbeddings({
    model: env.OPENAI_EMBEDDINGS_MODEL,
    dimensions: EMBEDDING_DIMENSION, // OpenAI text-embedding-3-* unterstützt dimension reduction
  });
  private readonly summarizer = new ChatOpenAI({
    model: env.OPENAI_COMPLETIONS_MODEL || DEFAULT_MODEL,
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

  async deleteSource(_userId?: string, sourceId?: string) {
    if (!sourceId) return true;
    const source = await prisma.knowledgeSource.findUnique({ where: { id: sourceId } });
    if (source) {
      // Nur die Vektoren dieser spezifischen Source löschen, NICHT alle vom Chatbot
      await this.vectorStore.deleteByKnowledgeSource({ chatbotId: source.chatbotId, knowledgeSourceId: source.id });
      await prisma.knowledgeSource.delete({ where: { id: source.id } });
    }
    return true;
  }

  async addTextSource(userId: string, chatbotId: string, title: string, content: string) {
    if (!chatbotId || !title || !content) {
      throw new Error("chatbotId, title und content sind erforderlich");
    }

    const markdown = `# ${title}\n\n${content}`;
    const source = await this.upsertKnowledgeSource({
      chatbotId,
      label: title,
      uri: null,
      type: "TEXT",
      metadata: { addedBy: userId },
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

    // Erstelle PENDING KnowledgeSource als Tracking-Eintrag
    const trackingSource = await prisma.knowledgeSource.create({
      data: {
        chatbotId: _chatbotId,
        label: `Scraping: ${firstUrl}`,
        uri: firstUrl,
        type: "URL",
        status: "PENDING",
        metadata: { startedAt: new Date().toISOString(), urls: opts.startUrls },
      },
    });

    try {
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

      // Lösche den Tracking-Eintrag, da wir jetzt echte Sources erstellen
      await prisma.knowledgeSource.delete({ where: { id: trackingSource.id } }).catch(() => {});

    for (const page of pages) {
      // 1. Verarbeite die HTML-Seite
      const title = page.title || page.canonical_url || page.page_url;
      const pageText = page.main_text || (page as any).text || (page as any).content || "";

      if (pageText.trim()) {
        const markdown = `# ${title}\n\n${pageText}`;

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

      // 2. Verarbeite angehängte PDFs
      const pdfs = (page as any).pdfs as Array<{
        pdf_url: string;
        title: string;
        pages?: Array<{ page_no: number; text: string }>;
        perplexity_content?: string;
        overall?: { page_count: number };
      }> | undefined;

      if (pdfs && Array.isArray(pdfs)) {
        for (const pdf of pdfs) {
          // PDF-Text extrahieren (entweder von Perplexity oder aus Pages)
          let pdfText = "";
          if (pdf.perplexity_content) {
            pdfText = pdf.perplexity_content;
          } else if (pdf.pages && Array.isArray(pdf.pages)) {
            pdfText = pdf.pages
              .sort((a, b) => a.page_no - b.page_no)
              .map((p) => p.text)
              .join("\n\n");
          }

          if (!pdfText.trim()) continue;

          const pdfTitle = pdf.title || pdf.pdf_url || "PDF-Dokument";
          const pdfMarkdown = `# ${pdfTitle}\n\n${pdfText}`;

          const pdfSource = await this.upsertKnowledgeSource({
            chatbotId: _chatbotId || "default-bot",
            label: pdfTitle,
            uri: pdf.pdf_url,
            type: "FILE",
            metadata: {
              fetchedAt: page.fetched_at,
              pageCount: pdf.overall?.page_count,
              sourcePage: page.canonical_url || page.page_url,
            },
          });

          await this.processIngestion({
            content: pdfMarkdown,
            metadata: {
              chatbotId: _chatbotId || "default-bot",
              knowledgeSourceId: pdfSource.id,
              title: pdfTitle,
              sourceUrl: pdf.pdf_url,
              datePublished: page.fetched_at,
              type: "pdf",
            },
          });
          ingested += 1;
        }
      }
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
    } catch (error) {
      // Bei Fehler: Tracking-Source auf FAILED setzen
      await prisma.knowledgeSource.update({
        where: { id: trackingSource.id },
        data: {
          status: "FAILED",
          label: `Fehler: ${firstUrl}`,
          metadata: {
            ...(trackingSource.metadata as object || {}),
            error: error instanceof Error ? error.message : String(error),
            failedAt: new Date().toISOString(),
          },
        },
      }).catch(() => {});

      console.error("scrapeAndIngest fehlgeschlagen:", error);
      throw error;
    }
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
    // Queue-basierte Verarbeitung ohne Race Condition
    const queue = chunks.map((chunk, index) => ({ chunk, index }));
    const results: EnrichedChunk[] = new Array(chunks.length);

    const processNext = async (): Promise<void> => {
      while (queue.length > 0) {
        const item = queue.shift(); // Atomic in JS single-thread event loop
        if (!item) break;

        const { chunk, index } = item;
        const summary = await this.generateSummary(title, chunk);
        const combined = `[Kontext: ${summary}]\n\n${chunk}`;
        results[index] = { combined, original: chunk, summary, index };
      }
    };

    // Starte MAX_CONCURRENCY parallele Worker
    const workerCount = Math.min(MAX_CONCURRENCY, chunks.length);
    await Promise.all(Array(workerCount).fill(null).map(() => processNext()));

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
    // Queue-basierte Verarbeitung ohne Race Condition
    const queue = [...chunks];
    const knowledgeSourceId = metadata.knowledgeSourceId;

    const processNext = async (): Promise<void> => {
      while (queue.length > 0) {
        const chunk = queue.shift(); // Atomic in JS single-thread event loop
        if (!chunk) break;

        const vector = this.normalizeVector(await this.embedSafe(chunk.combined));
        const enrichedMetadata = {
          chatbotId: metadata.chatbotId ?? "global",
          knowledgeSourceId: knowledgeSourceId ?? metadata.sourceUrl ?? metadata.filename ?? "unknown",
          title: metadata.title,
          sourceUrl: metadata.sourceUrl,
          filename: metadata.filename,
          datePublished: metadata.datePublished,
          type: metadata.type,
          chunkIndex: chunk.index,
          original_content: chunk.original,
        };

        // Speichere in Vector Store und erhalte die Vector-ID
        const vectorId = await this.vectorStore.upsertEmbedding({
          vector,
          metadata: enrichedMetadata,
          content: chunk.combined,
        });

        // Speichere auch in Prisma DB für späteres Löschen per ID
        if (knowledgeSourceId) {
          await prisma.embedding.create({
            data: {
              knowledgeSourceId,
              vectorId,
              content: chunk.combined,
              tokenCount: Math.ceil(chunk.combined.length / 4), // Approximation
            },
          });
        }
      }
    };

    // Starte MAX_CONCURRENCY parallele Worker
    const workerCount = Math.min(MAX_CONCURRENCY, chunks.length);
    await Promise.all(Array(workerCount).fill(null).map(() => processNext()));
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
    // Mock-Embeddings (SHA256) sind nur 32 Dimensionen - auf EMBEDDING_DIMENSION auffüllen
    if (vector.length < EMBEDDING_DIMENSION) {
      const padded = new Array(EMBEDDING_DIMENSION).fill(0);
      vector.forEach((v, i) => (padded[i] = v));
      return padded;
    }
    // Falls Vektor zu lang ist (sollte nicht passieren), kürzen
    if (vector.length > EMBEDDING_DIMENSION) {
      return vector.slice(0, EMBEDDING_DIMENSION);
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
