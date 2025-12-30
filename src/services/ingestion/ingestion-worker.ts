import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import { scraperRunner } from "../scraper/index.js";
import type { DatasetItem, DatasetPage, DatasetPdf, ScrapeOptions } from "../scraper/types.js";
import { getVectorStore } from "../vector-store/index.js";
import { provisioningEventsService } from "../provisioning-events.service.js";
import { canonicalizeText } from "./canonicalize.js";
import { chunkTextWithOffsets } from "./chunking.js";
import { computeChunkId, computePdfSourceRevision, computeSourceRevision } from "./chunk-id.js";
import { sha256Hex } from "./hash.js";
import { getEmbeddingsProvider } from "./embeddings.js";

const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 200;

const backoffMs = (attempt: number): number => Math.min(60_000, 1000 * Math.pow(2, Math.max(0, attempt - 1)));

type TextJobPayload = {
  title: string;
  content: string;
  uri?: string | null;
  canonicalUrl?: string | null;
  originalUrl?: string | null;
  extractionMethod?: string | null;
  textQuality?: string | null;
  phase1Anchor?: unknown | null;
};

type ScrapeJobPayload = {
  options: ScrapeOptions;
};

type DeleteJobPayload = {
  knowledgeSourceId: string;
};

export class IngestionWorker {
  private started = false;
  private inFlight = false;
  private timer: NodeJS.Timeout | null = null;

  start() {
    if (this.started) return;
    if (!env.INGESTION_WORKER_ENABLED) return;
    this.started = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, env.INGESTION_WORKER_POLL_MS);
    this.timer.unref();
    logger.info({ pollMs: env.INGESTION_WORKER_POLL_MS }, "IngestionWorker started");
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
  }

  private async tick() {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.reclaimStuckOutboxItems();
      await this.processNextPendingJob();
      await this.processOutboxBatch();
      await this.finalizeJobsIfPossible();
    } catch (err) {
      console.error("[IngestionWorker] tick failed:", err);
      logger.error({ err }, "IngestionWorker tick failed");
    } finally {
      this.inFlight = false;
    }
  }

  private async reclaimStuckOutboxItems(): Promise<void> {
    const ttlMs = env.OUTBOX_RUNNING_TTL_MS;
    const cutoff = new Date(Date.now() - ttlMs);
    const reclaimed = await prisma.vectorOutbox.updateMany({
      where: {
        status: "RUNNING",
        updatedAt: { lt: cutoff },
        attemptCount: { lt: env.INGESTION_MAX_VECTOR_ATTEMPTS },
      },
      data: {
        status: "FAILED",
        lastError: "reclaimed stale RUNNING outbox item",
        nextAttemptAt: new Date(),
      },
    });
    if (reclaimed.count > 0) {
      logger.warn({ reclaimed: reclaimed.count, cutoff: cutoff.toISOString() }, "Reclaimed stuck outbox items");
    }
  }

  private async processNextPendingJob(): Promise<void> {
    const job = await prisma.ingestionJob.findFirst({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
    });
    if (!job) return;

    console.log(`[IngestionWorker] Processing job ${job.id} (kind: ${job.kind}, chatbotId: ${job.chatbotId})`);

    const claimed = await prisma.ingestionJob.updateMany({
      where: { id: job.id, status: "PENDING" },
      data: { status: "RUNNING", startedAt: new Date(), error: null },
    });
    if (claimed.count !== 1) return;

    try {
      if (job.kind === "TEXT") {
        const payload = job.payload as unknown as TextJobPayload;
        if (!job.knowledgeSourceId) throw new Error("TEXT job missing knowledgeSourceId");
        await this.stageTextSource({
          jobId: job.id,
          chatbotId: job.chatbotId,
          knowledgeSourceId: job.knowledgeSourceId,
          title: payload.title,
          content: payload.content,
          uri: payload.uri ?? null,
          ...(payload.canonicalUrl !== undefined ? { canonicalUrl: payload.canonicalUrl } : {}),
          ...(payload.originalUrl !== undefined ? { originalUrl: payload.originalUrl } : {}),
          ...(payload.extractionMethod !== undefined ? { extractionMethod: payload.extractionMethod } : {}),
          ...(payload.textQuality !== undefined ? { textQuality: payload.textQuality } : {}),
          ...(payload.phase1Anchor !== undefined ? { phase1Anchor: payload.phase1Anchor } : {}),
        });
        return;
      }

      if (job.kind === "SCRAPE") {
        console.log(`[IngestionWorker] Starting SCRAPE job ${job.id}`);
        const payload = job.payload as unknown as ScrapeJobPayload;
        await this.runScrapeJob({ jobId: job.id, chatbotId: job.chatbotId, options: payload.options });
        console.log(`[IngestionWorker] SCRAPE job ${job.id} completed successfully`);
        return;
      }

      if (job.kind === "DELETE_SOURCE") {
        const payload = job.payload as unknown as DeleteJobPayload;
        await this.stageDeleteSource({ jobId: job.id, chatbotId: job.chatbotId, knowledgeSourceId: payload.knowledgeSourceId });
        return;
      }

      throw new Error(`Unsupported job kind: ${String(job.kind)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.ingestionJob.update({
        where: { id: job.id },
        data: { status: "FAILED", finishedAt: new Date(), error: message },
      });
      if (job.knowledgeSourceId) {
        try {
          await prisma.knowledgeSource.update({
            where: { id: job.knowledgeSourceId },
            data: { status: "FAILED", lastIngestionJobId: job.id },
          });
        } catch (updateErr) {
          logger.error({ err: updateErr, jobId: job.id, knowledgeSourceId: job.knowledgeSourceId }, "Failed to mark KnowledgeSource as FAILED");
        }
      }
      throw err;
    }
  }

  private async stageTextSource(args: {
    jobId: string;
    chatbotId: string;
    knowledgeSourceId: string;
    title: string;
    content: string;
    uri?: string | null;
    canonicalUrl?: string | null;
    originalUrl?: string | null;
    extractionMethod?: string | null;
    textQuality?: string | null;
    phase1Anchor?: unknown | null;
  }): Promise<number> {
    const canonicalDoc = canonicalizeText(args.content);
    const sourceRevision = computeSourceRevision(canonicalDoc);
    const anchoredChunks = chunkTextWithOffsets(canonicalDoc, { chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP });

    const chunkRows = anchoredChunks.map((chunk) => {
      const chunkId = computeChunkId({
        sourceId: args.knowledgeSourceId,
        sourceRevision,
        chunk,
      });
      return {
        chunkId,
        chatbotId: args.chatbotId,
        knowledgeSourceId: args.knowledgeSourceId,
        createdByIngestionJobId: args.jobId,
        updatedByIngestionJobId: args.jobId,
        sourceType: "TEXT" as const,
        uri: args.uri ?? null,
        canonicalUrl: args.canonicalUrl ?? null,
        originalUrl: args.originalUrl ?? null,
        extractionMethod: args.extractionMethod ?? null,
        textQuality: args.textQuality ?? null,
        phase1Anchor: (args.phase1Anchor ?? null) as any,
        title: args.title,
        sourceRevision,
        pageNo: null,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        canonicalText: chunk.text,
        canonicalTextHash: sha256Hex(chunk.text),
        embeddingModel: getEmbeddingsProvider().model,
        embeddingDimensions: getEmbeddingsProvider().dimensions,
        tokenCount: approxTokenCount(chunk.text),
        deletedAt: null,
      };
    });

    await prisma.$transaction(async (tx) => {
      const source = await tx.knowledgeSource.findUnique({ where: { id: args.knowledgeSourceId } });
      if (!source) throw new Error("KnowledgeSource not found");

      // Mark previous active chunks as deleted if revision changed.
      const activeChunks = await tx.knowledgeChunk.findMany({
        where: { knowledgeSourceId: args.knowledgeSourceId, deletedAt: null },
        select: { chunkId: true, sourceRevision: true },
      });

      const priorRevision = source.currentRevision ?? null;
      const revisionChanged = priorRevision !== sourceRevision && activeChunks.length > 0;
      if (revisionChanged) {
        await tx.knowledgeChunk.updateMany({
          where: { knowledgeSourceId: args.knowledgeSourceId, deletedAt: null },
          data: { deletedAt: new Date(), updatedByIngestionJobId: args.jobId },
        });

        await tx.vectorOutbox.createMany({
          data: activeChunks.map((c) => ({
            ingestionJobId: args.jobId,
            chatbotId: args.chatbotId,
            operation: "DELETE" as const,
            chunkId: c.chunkId,
          })),
          skipDuplicates: true,
        });
      }

      await tx.knowledgeChunk.createMany({ data: chunkRows, skipDuplicates: true });
      await tx.vectorOutbox.createMany({
        data: chunkRows.map((c) => ({
          ingestionJobId: args.jobId,
          chatbotId: args.chatbotId,
          operation: "UPSERT" as const,
          chunkId: c.chunkId,
        })),
        skipDuplicates: true,
      });

      await tx.knowledgeSource.update({
        where: { id: args.knowledgeSourceId },
        data: {
          status: "PENDING",
          currentRevision: sourceRevision,
          lastIngestionJobId: args.jobId,
          canonicalUrl: args.canonicalUrl ?? source.canonicalUrl ?? null,
          originalUrl: args.originalUrl ?? source.originalUrl ?? null,
          extractionMethod: args.extractionMethod ?? source.extractionMethod ?? null,
          textQuality: args.textQuality ?? source.textQuality ?? null,
        },
      });

      await tx.ingestionJob.update({
        where: { id: args.jobId },
        data: { totalChunks: chunkRows.length },
      });
    });
    return chunkRows.length;
  }

  private async runScrapeJob(args: { jobId: string; chatbotId: string; options: ScrapeOptions }) {
    console.log(`[IngestionWorker] runScrapeJob: calling scraperRunner.run() for job ${args.jobId}`);
    const datasetItems: DatasetItem[] = await scraperRunner.run(args.options);
    if (!Array.isArray(datasetItems)) throw new Error("Scraper returned invalid dataset");

    const pages: DatasetPage[] = [];
    const pdfItems: DatasetPdf[] = [];
    for (const item of datasetItems) {
      if (item.type === "page") {
        pages.push(item);
      } else if (item.type === "pdf") {
        pdfItems.push(item);
      }
    }

    console.log(
      `[IngestionWorker] runScrapeJob: scraperRunner returned ${datasetItems.length} items (${pages.length} pages, ${pdfItems.length} pdfs)`
    );

    let stagedChunks = 0;
    const handledPdfUrls = new Set<string>();

    const ingestPdf = async (pdf: DatasetPdf, context: { sourcePage?: string | null; fetchedAt?: string | null }) => {
      const pdfTitle = pdf.title || pdf.pdf_url || "PDF-Dokument";
      const pdfUri = pdf.pdf_url;
      if (!pdfUri) return 0;

      if (handledPdfUrls.has(pdfUri)) return 0;
      handledPdfUrls.add(pdfUri);

      const pagesArr = (pdf.pages || []).map((p) => ({ pageNo: p.page_no, text: p.text }));
      if (!pagesArr.length && !pdf.perplexity_content) return 0;

      const pdfSource = await this.upsertKnowledgeSource({
        chatbotId: args.chatbotId,
        label: pdfTitle,
        uri: pdfUri,
        canonicalUrl: pdfUri,
        originalUrl: pdfUri,
        extractionMethod: (pdf.extraction_method ?? null) as any,
        textQuality: (pdf.text_quality ?? null) as any,
        type: "FILE",
        metadata: {
          fetchedAt: context.fetchedAt ?? pdf.fetched_at ?? null,
          pageCount: pdf.overall?.page_count,
          sourcePage: context.sourcePage ?? pdf.source_page ?? null,
        },
        jobId: args.jobId,
      });

      if (pdf.perplexity_content) {
        // We cannot produce page anchors from a flat Perplexity blob -> hard fail.
        throw new Error(`PDF ${pdfUri} missing pages[]; cannot generate required page anchors`);
      }

      return await this.stagePdfSource({
        jobId: args.jobId,
        chatbotId: args.chatbotId,
        knowledgeSourceId: pdfSource.id,
        title: pdfTitle,
        uri: pdfUri,
        canonicalUrl: pdfUri,
        originalUrl: pdfUri,
        extractionMethod: (pdf.extraction_method ?? null) as any,
        textQuality: (pdf.text_quality ?? null) as any,
        pages: pagesArr,
      });
    };

    for (const page of pages) {
      const title = page.title || page.canonical_url || page.page_url;
      const uri = page.canonical_url || page.page_url;
      const canonicalUrl = page.canonical_url || null;
      const originalUrl = page.page_url || null;
      const pageText = page.main_text || "";
      console.log(`[IngestionWorker] Processing page: ${title?.substring(0, 50)}, text length: ${pageText?.length ?? 0}`);
      if (pageText.trim()) {
        console.log(`[IngestionWorker] Creating KnowledgeSource for: ${uri?.substring(0, 80)}`);
        const source = await this.upsertKnowledgeSource({
          chatbotId: args.chatbotId,
          label: title,
          uri,
          canonicalUrl,
          originalUrl,
          extractionMethod: null,
          textQuality: null,
          type: "URL",
          metadata: { fetchedAt: page.fetched_at, meta: page.meta, lang: page.lang },
          jobId: args.jobId,
        });

        console.log(`[IngestionWorker] KnowledgeSource created with id: ${source.id}`);
        const chunks = await this.stageWebLikeSource({
          jobId: args.jobId,
          chatbotId: args.chatbotId,
          knowledgeSourceId: source.id,
          sourceType: "WEB",
          title,
          uri,
          canonicalUrl,
          originalUrl,
          extractionMethod: null,
          textQuality: null,
          content: pageText,
        });
        console.log(`[IngestionWorker] Staged ${chunks} chunks for source ${source.id}`);
        stagedChunks += chunks;
      }

      const pdfs = page.pdfs;
      if (pdfs && Array.isArray(pdfs)) {
        for (const pdf of pdfs) {
          stagedChunks += await ingestPdf(pdf, { sourcePage: uri, fetchedAt: page.fetched_at });
        }
      }
    }

    for (const pdf of pdfItems) {
      stagedChunks += await ingestPdf(pdf, {
        sourcePage: pdf.source_page ?? null,
        fetchedAt: pdf.fetched_at ?? null,
      });
    }

    if (stagedChunks === 0) {
      throw new Error("Scrape job produced no ingestible content");
    }
  }

  private async stageWebLikeSource(args: {
    jobId: string;
    chatbotId: string;
    knowledgeSourceId: string;
    sourceType: "WEB" | "TEXT";
    title: string;
    uri: string | null;
    canonicalUrl?: string | null;
    originalUrl?: string | null;
    extractionMethod?: string | null;
    textQuality?: string | null;
    phase1Anchor?: unknown | null;
    content: string;
  }): Promise<number> {
    if (args.sourceType === "WEB" && !args.uri) throw new Error("WEB source requires uri for citations");

    const canonicalDoc = canonicalizeText(args.content);
    const sourceRevision = computeSourceRevision(canonicalDoc);
    const anchoredChunks = chunkTextWithOffsets(canonicalDoc, { chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP });

    const chunkRows = anchoredChunks.map((chunk) => {
      const chunkId = computeChunkId({
        sourceId: args.knowledgeSourceId,
        sourceRevision,
        chunk,
      });
      return {
        chunkId,
        chatbotId: args.chatbotId,
        knowledgeSourceId: args.knowledgeSourceId,
        createdByIngestionJobId: args.jobId,
        updatedByIngestionJobId: args.jobId,
        sourceType: args.sourceType,
        uri: args.uri,
        canonicalUrl: args.canonicalUrl ?? null,
        originalUrl: args.originalUrl ?? null,
        extractionMethod: args.extractionMethod ?? null,
        textQuality: args.textQuality ?? null,
        phase1Anchor: (args.phase1Anchor ?? null) as any,
        title: args.title,
        sourceRevision,
        pageNo: null,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        canonicalText: chunk.text,
        canonicalTextHash: sha256Hex(chunk.text),
        embeddingModel: getEmbeddingsProvider().model,
        embeddingDimensions: getEmbeddingsProvider().dimensions,
        tokenCount: approxTokenCount(chunk.text),
        deletedAt: null,
      };
    });

    await prisma.$transaction(async (tx) => {
      const source = await tx.knowledgeSource.findUnique({ where: { id: args.knowledgeSourceId } });
      if (!source) throw new Error("KnowledgeSource not found");

      const activeChunks = await tx.knowledgeChunk.findMany({
        where: { knowledgeSourceId: args.knowledgeSourceId, deletedAt: null },
        select: { chunkId: true },
      });

      const priorRevision = source.currentRevision ?? null;
      const revisionChanged = priorRevision !== sourceRevision && activeChunks.length > 0;
      if (revisionChanged) {
        await tx.knowledgeChunk.updateMany({
          where: { knowledgeSourceId: args.knowledgeSourceId, deletedAt: null },
          data: { deletedAt: new Date(), updatedByIngestionJobId: args.jobId },
        });
        await tx.vectorOutbox.createMany({
          data: activeChunks.map((c) => ({
            ingestionJobId: args.jobId,
            chatbotId: args.chatbotId,
            operation: "DELETE" as const,
            chunkId: c.chunkId,
          })),
          skipDuplicates: true,
        });
      }

      await tx.knowledgeChunk.createMany({ data: chunkRows, skipDuplicates: true });
      await tx.vectorOutbox.createMany({
        data: chunkRows.map((c) => ({
          ingestionJobId: args.jobId,
          chatbotId: args.chatbotId,
          operation: "UPSERT" as const,
          chunkId: c.chunkId,
        })),
        skipDuplicates: true,
      });

      await tx.knowledgeSource.update({
        where: { id: args.knowledgeSourceId },
        data: {
          status: "PENDING",
          currentRevision: sourceRevision,
          lastIngestionJobId: args.jobId,
          canonicalUrl: args.canonicalUrl ?? source.canonicalUrl ?? null,
          originalUrl: args.originalUrl ?? source.originalUrl ?? null,
          extractionMethod: args.extractionMethod ?? source.extractionMethod ?? null,
          textQuality: args.textQuality ?? source.textQuality ?? null,
        },
      });
    });
    return chunkRows.length;
  }

  private async stagePdfSource(args: {
    jobId: string;
    chatbotId: string;
    knowledgeSourceId: string;
    title: string;
    uri: string;
    canonicalUrl?: string | null;
    originalUrl?: string | null;
    extractionMethod?: string | null;
    textQuality?: string | null;
    phase1Anchor?: unknown | null;
    pages: Array<{ pageNo: number; text: string }>;
  }): Promise<number> {
    if (!args.uri) throw new Error("PDF uri required");
    if (!args.pages.length) throw new Error("PDF pages required for anchors");

    const canonicalPages = args.pages
      .map((p) => ({ pageNo: p.pageNo, canonicalText: canonicalizeText(p.text) }))
      .filter((p) => p.canonicalText.trim().length > 0);

    if (!canonicalPages.length) throw new Error("PDF pages empty after canonicalization");

    const sourceRevision = computePdfSourceRevision(canonicalPages);
    const chunkRows = canonicalPages.flatMap((p) => {
      const anchored = chunkTextWithOffsets(p.canonicalText, { chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP });
      return anchored.map((chunk) => {
        const chunkId = computeChunkId({
          sourceId: args.knowledgeSourceId,
          sourceRevision,
          pageNo: p.pageNo,
          chunk,
        });
        return {
          chunkId,
          chatbotId: args.chatbotId,
          knowledgeSourceId: args.knowledgeSourceId,
          createdByIngestionJobId: args.jobId,
          updatedByIngestionJobId: args.jobId,
          sourceType: "PDF" as const,
          uri: args.uri,
          canonicalUrl: args.canonicalUrl ?? null,
          originalUrl: args.originalUrl ?? null,
          extractionMethod: args.extractionMethod ?? null,
          textQuality: args.textQuality ?? null,
          phase1Anchor: (args.phase1Anchor ?? null) as any,
          title: args.title,
          sourceRevision,
          pageNo: p.pageNo,
          startOffset: chunk.startOffset,
          endOffset: chunk.endOffset,
          canonicalText: chunk.text,
          canonicalTextHash: sha256Hex(chunk.text),
          embeddingModel: getEmbeddingsProvider().model,
          embeddingDimensions: getEmbeddingsProvider().dimensions,
          tokenCount: approxTokenCount(chunk.text),
          deletedAt: null,
        };
      });
    });

    if (!chunkRows.length) throw new Error("No PDF chunks produced");

    await prisma.$transaction(async (tx) => {
      const source = await tx.knowledgeSource.findUnique({ where: { id: args.knowledgeSourceId } });
      if (!source) throw new Error("KnowledgeSource not found");

      const activeChunks = await tx.knowledgeChunk.findMany({
        where: { knowledgeSourceId: args.knowledgeSourceId, deletedAt: null },
        select: { chunkId: true },
      });

      const priorRevision = source.currentRevision ?? null;
      const revisionChanged = priorRevision !== sourceRevision && activeChunks.length > 0;
      if (revisionChanged) {
        await tx.knowledgeChunk.updateMany({
          where: { knowledgeSourceId: args.knowledgeSourceId, deletedAt: null },
          data: { deletedAt: new Date(), updatedByIngestionJobId: args.jobId },
        });
        await tx.vectorOutbox.createMany({
          data: activeChunks.map((c) => ({
            ingestionJobId: args.jobId,
            chatbotId: args.chatbotId,
            operation: "DELETE" as const,
            chunkId: c.chunkId,
          })),
          skipDuplicates: true,
        });
      }

      await tx.knowledgeChunk.createMany({ data: chunkRows, skipDuplicates: true });
      await tx.vectorOutbox.createMany({
        data: chunkRows.map((c) => ({
          ingestionJobId: args.jobId,
          chatbotId: args.chatbotId,
          operation: "UPSERT" as const,
          chunkId: c.chunkId,
        })),
        skipDuplicates: true,
      });

      await tx.knowledgeSource.update({
        where: { id: args.knowledgeSourceId },
        data: {
          status: "PENDING",
          currentRevision: sourceRevision,
          lastIngestionJobId: args.jobId,
          canonicalUrl: args.canonicalUrl ?? source.canonicalUrl ?? null,
          originalUrl: args.originalUrl ?? source.originalUrl ?? null,
          extractionMethod: args.extractionMethod ?? source.extractionMethod ?? null,
          textQuality: args.textQuality ?? source.textQuality ?? null,
        },
      });
    });
    return chunkRows.length;
  }

  private async stageDeleteSource(args: { jobId: string; chatbotId: string; knowledgeSourceId: string }) {
    await prisma.$transaction(async (tx) => {
      const chunks = await tx.knowledgeChunk.findMany({
        where: { knowledgeSourceId: args.knowledgeSourceId, deletedAt: null },
        select: { chunkId: true },
      });
      if (chunks.length) {
        await tx.knowledgeChunk.updateMany({
          where: { knowledgeSourceId: args.knowledgeSourceId, deletedAt: null },
          data: { deletedAt: new Date(), updatedByIngestionJobId: args.jobId },
        });
        await tx.vectorOutbox.createMany({
          data: chunks.map((c) => ({
            ingestionJobId: args.jobId,
            chatbotId: args.chatbotId,
            operation: "DELETE" as const,
            chunkId: c.chunkId,
          })),
          skipDuplicates: true,
        });
      }
      await tx.knowledgeSource.update({
        where: { id: args.knowledgeSourceId },
        data: { status: "PENDING", lastIngestionJobId: args.jobId },
      });
    });
  }

  private async processOutboxBatch(): Promise<void> {
    const items = await prisma.vectorOutbox.findMany({
      where: {
        status: { in: ["PENDING", "FAILED"] },
        nextAttemptAt: { lte: new Date() },
        attemptCount: { lt: env.INGESTION_MAX_VECTOR_ATTEMPTS },
      },
      orderBy: { createdAt: "asc" },
      take: 10,
    });
    if (!items.length) return;

    console.log(`[IngestionWorker] processOutboxBatch: processing ${items.length} outbox items`);

    const vectorStore = getVectorStore();
    const embeddings = getEmbeddingsProvider();

    for (const item of items) {
      const claimed = await prisma.vectorOutbox.updateMany({
        where: { id: item.id, status: { in: ["PENDING", "FAILED"] } },
        data: { status: "RUNNING", attemptCount: { increment: 1 } },
      });
      if (claimed.count !== 1) continue;

      try {
        if (item.operation === "UPSERT") {
          const chunk = await prisma.knowledgeChunk.findUnique({ where: { chunkId: item.chunkId } });
          if (!chunk) throw new Error("Chunk not found for UPSERT");
          assertValidCitationFields(chunk);

          const vector = await embeddings.embed(chunk.canonicalText);
          await vectorStore.upsertEmbedding({
            vectorId: chunk.chunkId,
            vector,
            metadata: {
              chatbotId: chunk.chatbotId,
              chunk_id: chunk.chunkId,
              source_id: chunk.knowledgeSourceId,
              source_type: chunk.sourceType,
              uri: chunk.uri,
              canonical_url: chunk.canonicalUrl ?? null,
              original_url: chunk.originalUrl ?? null,
              extraction_method: chunk.extractionMethod ?? null,
              text_quality: chunk.textQuality ?? null,
              phase1_anchor: (chunk.phase1Anchor ?? null) as any,
              title: chunk.title,
              page_no: chunk.pageNo ?? null,
              start_offset: chunk.startOffset,
              end_offset: chunk.endOffset,
              source_revision: chunk.sourceRevision,
              embedding_model: chunk.embeddingModel,
              embedding_dimensions: chunk.embeddingDimensions,
            },
          });
        } else if (item.operation === "DELETE") {
          await vectorStore.deleteByIds({ chatbotId: item.chatbotId, vectorIds: [item.chunkId] });
        } else {
          throw new Error(`Unknown outbox operation: ${String(item.operation)}`);
        }

        await prisma.vectorOutbox.update({
          where: { id: item.id },
          data: { status: "SUCCEEDED", processedAt: new Date(), lastError: null, nextAttemptAt: new Date() },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[IngestionWorker] Outbox item ${item.id} failed: ${message}`);
        const attempt = item.attemptCount + 1;
        const retryAt = new Date(Date.now() + backoffMs(attempt));
        await prisma.vectorOutbox.update({
          where: { id: item.id },
          data: {
            status: "FAILED",
            lastError: message,
            nextAttemptAt: retryAt,
          },
        });
        try {
          await prisma.ingestionJob.update({
            where: { id: item.ingestionJobId },
            data: { failedVectors: { increment: 1 }, error: message },
          });
        } catch (updateErr) {
          logger.error({ err: updateErr, ingestionJobId: item.ingestionJobId }, "Failed to update IngestionJob failure counters");
        }
      }
    }
  }

  private async finalizeJobsIfPossible(): Promise<void> {
    const running = await prisma.ingestionJob.findMany({
      where: { status: "RUNNING" },
      select: { id: true, knowledgeSourceId: true, chatbotId: true, kind: true, startedAt: true },
      take: 20,
      orderBy: { createdAt: "asc" },
    });
    if (!running.length) return;

    console.log(`[IngestionWorker] finalizeJobsIfPossible: found ${running.length} RUNNING jobs`);

    for (const job of running) {
      const totalOutbox = await prisma.vectorOutbox.count({ where: { ingestionJobId: job.id } });
      console.log(`[IngestionWorker] Job ${job.id}: totalOutbox=${totalOutbox}`);
      if (totalOutbox === 0) {
        const startedAt = job.startedAt ?? null;
        const cutoff = new Date(Date.now() - env.OUTBOX_RUNNING_TTL_MS);
        if (startedAt && startedAt < cutoff) {
          await prisma.ingestionJob.update({
            where: { id: job.id },
            data: { status: "FAILED", finishedAt: new Date(), error: "Job stuck in RUNNING without outbox items (reclaimed)" },
          });
          continue;
        }
        // Give the job a chance to stage chunks/outbox.
        continue;
      }

      const pendingOrRunning = await prisma.vectorOutbox.count({
        where: { ingestionJobId: job.id, status: { in: ["PENDING", "RUNNING"] } },
      });
      console.log(`[IngestionWorker] Job ${job.id}: pendingOrRunning=${pendingOrRunning}`);
      if (pendingOrRunning > 0) continue;

      const retryableFailed = await prisma.vectorOutbox.count({
        where: {
          ingestionJobId: job.id,
          status: "FAILED",
          attemptCount: { lt: env.INGESTION_MAX_VECTOR_ATTEMPTS },
        },
      });
      if (retryableFailed > 0) continue;

      const terminalFailed = await prisma.vectorOutbox.count({
        where: {
          ingestionJobId: job.id,
          status: "FAILED",
          attemptCount: { gte: env.INGESTION_MAX_VECTOR_ATTEMPTS },
        },
      });

      const nextStatus = terminalFailed > 0 ? "PARTIAL_FAILED" : "SUCCEEDED";
      console.log(`[IngestionWorker] Job ${job.id}: finalizing with status=${nextStatus}, terminalFailed=${terminalFailed}`);
      await prisma.ingestionJob.update({
        where: { id: job.id },
        data: { status: nextStatus, finishedAt: new Date() },
      });

      if (nextStatus === "SUCCEEDED" && job.kind !== "DELETE_SOURCE") {
        try {
          console.log(`[IngestionWorker] Job ${job.id}: setting chatbot ${job.chatbotId} to ACTIVE`);
          await prisma.chatbot.update({ where: { id: job.chatbotId }, data: { status: "ACTIVE" } });
          provisioningEventsService.publish(job.chatbotId, { type: "completed", chatbotId: job.chatbotId, status: "ACTIVE" });
          console.log(`[IngestionWorker] Job ${job.id}: chatbot ${job.chatbotId} is now ACTIVE`);
        } catch (updateErr) {
          logger.error({ err: updateErr, chatbotId: job.chatbotId }, "Failed to mark Chatbot as ACTIVE after ingestion");
        }
      } else if (nextStatus !== "SUCCEEDED") {
        provisioningEventsService.publish(job.chatbotId, {
          type: "failed",
          chatbotId: job.chatbotId,
          status: nextStatus,
        });
      }

      if (job.knowledgeSourceId) {
        if (nextStatus === "SUCCEEDED") {
          if (job.kind === "DELETE_SOURCE") {
            try {
              await prisma.knowledgeSource.delete({ where: { id: job.knowledgeSourceId } });
            } catch (deleteErr) {
              logger.error({ err: deleteErr, knowledgeSourceId: job.knowledgeSourceId }, "Failed to delete KnowledgeSource after vector deletes");
            }
          } else {
            try {
              await prisma.knowledgeSource.update({
                where: { id: job.knowledgeSourceId },
                data: { status: "READY", lastIngestedAt: new Date() },
              });
            } catch (updateErr) {
              logger.error({ err: updateErr, knowledgeSourceId: job.knowledgeSourceId }, "Failed to mark KnowledgeSource as READY");
            }
          }
        } else {
          try {
            await prisma.knowledgeSource.update({
              where: { id: job.knowledgeSourceId },
              data: { status: "FAILED" },
            });
          } catch (updateErr) {
            logger.error({ err: updateErr, knowledgeSourceId: job.knowledgeSourceId }, "Failed to mark KnowledgeSource as FAILED after ingestion");
          }
        }
      } else if (job.kind === "SCRAPE") {
        try {
          if (nextStatus === "SUCCEEDED") {
            await prisma.knowledgeSource.updateMany({
              where: { chatbotId: job.chatbotId, lastIngestionJobId: job.id },
              data: { status: "READY", lastIngestedAt: new Date() },
            });
          } else {
            await prisma.knowledgeSource.updateMany({
              where: { chatbotId: job.chatbotId, lastIngestionJobId: job.id },
              data: { status: "FAILED" },
            });
          }
        } catch (updateErr) {
          logger.error(
            { err: updateErr, chatbotId: job.chatbotId, ingestionJobId: job.id },
            "Failed to update KnowledgeSources after scrape ingestion",
          );
        }
      }
    }
  }

  private async upsertKnowledgeSource(args: {
    chatbotId: string;
    label: string;
    uri: string | null;
    canonicalUrl: string | null;
    originalUrl: string | null;
    extractionMethod: string | null;
    textQuality: string | null;
    type: "URL" | "TEXT" | "FILE";
    metadata: Record<string, any>;
    jobId: string;
  }) {
    const existing = args.uri
      ? await prisma.knowledgeSource.findFirst({ where: { chatbotId: args.chatbotId, uri: args.uri } })
      : null;
    if (existing) {
      return prisma.knowledgeSource.update({
        where: { id: existing.id },
        data: {
          label: args.label,
          metadata: args.metadata,
          status: "PENDING",
          lastIngestionJobId: args.jobId,
          canonicalUrl: args.canonicalUrl,
          originalUrl: args.originalUrl,
          extractionMethod: args.extractionMethod,
          textQuality: args.textQuality,
        },
      });
    }
    return prisma.knowledgeSource.create({
      data: {
        chatbotId: args.chatbotId,
        label: args.label,
        uri: args.uri,
        canonicalUrl: args.canonicalUrl,
        originalUrl: args.originalUrl,
        extractionMethod: args.extractionMethod,
        textQuality: args.textQuality,
        type: args.type,
        metadata: args.metadata,
        status: "PENDING",
        lastIngestionJobId: args.jobId,
      },
    });
  }
}

const approxTokenCount = (text: string): number => Math.ceil(text.length / 4);

const assertValidCitationFields = (chunk: {
  sourceType: string;
  uri: string | null;
  pageNo: number | null;
  startOffset: number;
  endOffset: number;
}) => {
  if (!Number.isInteger(chunk.startOffset) || !Number.isInteger(chunk.endOffset) || chunk.endOffset <= chunk.startOffset) {
    throw new Error("Invalid chunk offsets");
  }
  if (chunk.sourceType === "WEB" && !chunk.uri) throw new Error("WEB chunk missing uri");
  if (chunk.sourceType === "PDF" && (chunk.pageNo === null || !Number.isInteger(chunk.pageNo))) {
    throw new Error("PDF chunk missing pageNo");
  }
};

export const ingestionWorker = new IngestionWorker();
