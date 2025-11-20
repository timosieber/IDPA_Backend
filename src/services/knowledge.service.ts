import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { BadRequestError, NotFoundError } from "../utils/errors.js";
import { chunkText } from "../utils/chunk-text.js";
import { chatbotService } from "./chatbot.service.js";
import { embeddingService } from "./embedding.service.js";
import { getVectorStore } from "./vector-store/index.js";
import { scraperRunner } from "./scraper/index.js";
import { promptGeneratorService } from "./prompt-generator.service.js";
import { logger } from "../lib/logger.js";
import type { ScrapeOptions } from "./scraper/types.js";

const vectorStore = getVectorStore();
const MIN_TEXT_LENGTH = 200;

class KnowledgeService {
  private async embedChunksForSource({
    chatbotId,
    sourceId,
    label,
    chunks,
  }: {
    chatbotId: string;
    sourceId: string;
    label: string;
    chunks: string[];
  }) {
    let chunkIndex = 0;
    for (const chunk of chunks) {
      const embedding = await embeddingService.embedText(chunk);
      const vectorId = await vectorStore.upsertEmbedding({
        vector: embedding,
        metadata: {
          chatbotId,
          knowledgeSourceId: sourceId,
          chunkIndex,
          label,
        },
        content: chunk,
      });

      await prisma.embedding.create({
        data: {
          knowledgeSourceId: sourceId,
          vectorId,
          content: chunk,
          tokenCount: chunk.length,
        },
      });
      chunkIndex += 1;
    }
  }

  private async resetSourceEmbeddings(chatbotId: string, sourceId: string) {
    await vectorStore.deleteByKnowledgeSource({ chatbotId, knowledgeSourceId: sourceId });
    await prisma.embedding.deleteMany({ where: { knowledgeSourceId: sourceId } });
  }

  async listSources(userId: string, chatbotId: string) {
    await chatbotService.getById(userId, chatbotId);
    return prisma.knowledgeSource.findMany({
      where: { chatbotId },
      include: { embeddings: true },
      orderBy: { createdAt: "desc" },
    });
  }

  async addTextSource(userId: string, chatbotId: string, label: string, content: string) {
    if (!content.trim()) {
      throw new BadRequestError("Content darf nicht leer sein");
    }

    await chatbotService.getById(userId, chatbotId);
    const data: Prisma.KnowledgeSourceUncheckedCreateInput = {
      chatbotId,
      label,
      type: "TEXT",
      uri: null,
    };

    const source = await prisma.knowledgeSource.create({ data });

    try {
      const chunks = chunkText(content);
      if (!chunks.length) {
        throw new BadRequestError("Zu wenig Text für Embeddings gefunden");
      }

      await this.embedChunksForSource({ chatbotId, sourceId: source.id, label, chunks });

      await prisma.knowledgeSource.update({
        where: { id: source.id },
        data: { status: "READY" },
      });
      return source;
    } catch (error) {
      await prisma.knowledgeSource.update({
        where: { id: source.id },
        data: { status: "FAILED" },
      });
      throw error;
    }
  }

  async deleteSource(userId: string, knowledgeSourceId: string) {
    const source = await prisma.knowledgeSource.findUnique({ where: { id: knowledgeSourceId } });
    if (!source) {
      throw new NotFoundError("Quelle nicht gefunden");
    }
    await chatbotService.getById(userId, source.chatbotId);
    await this.resetSourceEmbeddings(source.chatbotId, source.id);
    await prisma.knowledgeSource.delete({ where: { id: source.id } });
  }

  async retrieveContext(chatbotId: string, question: string) {
    const embedding = await embeddingService.embedText(question);
    const matches = await vectorStore.similaritySearch({ chatbotId, vector: embedding, topK: 4 });
    return matches.map((match) => match.content);
  }

  async scrapeAndIngest(
    userId: string,
    chatbotId: string,
    options: ScrapeOptions,
  ): Promise<{ sources: Array<{ id: string; label: string; chunks: number }>; pagesScanned: number }> {
    const chatbot = await chatbotService.getById(userId, chatbotId);

    const pages = await scraperRunner.run(options);
    if (!pages.length) {
      throw new BadRequestError("Keine Seiten konnten extrahiert werden");
    }

    const ingested: Array<{ id: string; label: string; chunks: number }> = [];

    // Generiere Custom System Prompt basierend auf gescrapten Daten
    try {
      const currentPrompt = (chatbot as any).systemPrompt;
      if (!currentPrompt) {
        logger.info(`Generiere System Prompt für Chatbot ${chatbotId}...`);
        const generatedPrompt = await promptGeneratorService.generateSystemPrompt(pages as any);

        // Update Chatbot mit generiertem Prompt
        await prisma.chatbot.update({
          where: { id: chatbotId },
          data: { systemPrompt: generatedPrompt } as any,
        });

        logger.info(`System Prompt erfolgreich generiert und gespeichert für Chatbot ${chatbotId}`);
      } else {
        logger.info(`Chatbot ${chatbotId} hat bereits einen Custom System Prompt - überspringe Generierung`);
      }
    } catch (error) {
      logger.error({ err: error }, `Fehler bei System Prompt Generierung für Chatbot ${chatbotId}`);
      // Nicht fatal - Scraping läuft weiter
    }

    for (const page of pages) {
      const pageText = page.main_text?.replace(/\s+/g, " ").trim() ?? "";
      const pageLabel = page.title?.trim() || page.canonical_url;
      const pageMetadata: Prisma.InputJsonValue = {
        headings: {
          h1: [...(page.headings?.h1 ?? [])],
          h2: [...(page.headings?.h2 ?? [])],
          h3: [...(page.headings?.h3 ?? [])],
        } as Prisma.InputJsonValue,
        lang: (page.lang ?? {}) as Prisma.InputJsonValue,
        meta: (page.meta ?? {}) as Prisma.InputJsonValue,
        links: (page.links ?? []).map((link) => ({
          href: link.href,
          canonical_href: link.canonical_href,
          anchor_text: link.anchor_text,
          context_snippet: link.context_snippet,
        })) as Prisma.InputJsonValue,
        fetchedAt: page.fetched_at,
      };

      if (pageText.length >= MIN_TEXT_LENGTH) {
        const source = await this.upsertScrapedSource({
          chatbotId,
          label: pageLabel,
          uri: page.canonical_url,
          type: "URL",
          metadata: pageMetadata,
        });

        const chunks = chunkText(pageText);
        await this.persistChunksForSource({ chatbotId, sourceId: source.id, label: pageLabel, chunks, ingested });
      }

      for (const pdf of page.pdfs ?? []) {
        const pdfRawText =
          pdf.perplexity_content ?? pdf.pages.map((pdfPage) => pdfPage.text).join("\n\n");
        const pdfText = pdfRawText?.replace(/\s+/g, " ").trim() ?? "";
        if (pdfText.length < MIN_TEXT_LENGTH) continue;

        const pdfLabel = pdf.title?.trim() || pdf.pdf_url;
        const pdfMetadata: Prisma.InputJsonValue = {
          sourcePage: page.page_url,
          httpHead: pdf.http_head,
          rangeSupported: pdf.range_supported,
          bytesLoaded: pdf.bytes_loaded,
          extractionMethod: pdf.extraction_method,
          overall: pdf.overall,
        };

        const pdfSource = await this.upsertScrapedSource({
          chatbotId,
          label: pdfLabel,
          uri: pdf.pdf_url,
          type: "FILE",
          metadata: pdfMetadata,
        });

        const pdfChunks = chunkText(pdfText);
        await this.persistChunksForSource({ chatbotId, sourceId: pdfSource.id, label: pdfLabel, chunks: pdfChunks, ingested });
      }
    }

    if (!ingested.length) {
      throw new BadRequestError("Keine verwertbaren Inhalte nach dem Scrapen gefunden");
    }

    return { sources: ingested, pagesScanned: pages.length };
  }

  private async persistChunksForSource({
    chatbotId,
    sourceId,
    label,
    chunks,
    ingested,
  }: {
    chatbotId: string;
    sourceId: string;
    label: string;
    chunks: string[];
    ingested: Array<{ id: string; label: string; chunks: number }>;
  }) {
    if (!chunks.length) {
      throw new BadRequestError("Zu wenig Text für Embeddings gefunden");
    }
    try {
      await this.embedChunksForSource({ chatbotId, sourceId, label, chunks });
      await prisma.knowledgeSource.update({
        where: { id: sourceId },
        data: { status: "READY" },
      });
      ingested.push({ id: sourceId, label, chunks: chunks.length });
    } catch (error) {
      await prisma.knowledgeSource.update({
        where: { id: sourceId },
        data: { status: "FAILED" },
      });
      throw error;
    }
  }

  private async upsertScrapedSource({
    chatbotId,
    label,
    uri,
    type,
    metadata,
  }: {
    chatbotId: string;
    label: string;
    uri: string;
    type: Prisma.KnowledgeSourceUncheckedCreateInput["type"];
    metadata: Prisma.InputJsonValue;
  }) {
    let source = await prisma.knowledgeSource.findFirst({
      where: { chatbotId, uri },
    });

    if (source) {
      await this.resetSourceEmbeddings(chatbotId, source.id);
      source = await prisma.knowledgeSource.update({
        where: { id: source.id },
        data: {
          label,
          status: "PENDING",
          metadata,
        },
      });
      return source;
    }

    return prisma.knowledgeSource.create({
      data: {
        chatbotId,
        label,
        type,
        uri,
        metadata,
        status: "PENDING",
      },
    });
  }
}

export const knowledgeService = new KnowledgeService();
