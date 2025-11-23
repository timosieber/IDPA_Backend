import { Router } from "express";
import { z } from "zod";
import { knowledgeService } from "../services/knowledge.service.js";
import { prisma } from "../lib/prisma.js";

const router = Router();

const addTextSchema = z.object({
  chatbotId: z.string().min(8),
  label: z.string().min(3),
  content: z.string().min(20),
});

const scrapeSchema = z.object({
  chatbotId: z.string().min(8),
  startUrls: z.array(z.string().url()).min(1).max(10),
  maxDepth: z.number().min(0).max(5).optional(),
  maxPages: z.number().min(1).max(50).optional(),
  respectRobotsTxt: z.boolean().optional(),
  includeGlobs: z.array(z.string().min(2)).max(20).optional(),
  excludeGlobs: z.array(z.string().min(2)).max(20).optional(),
  maxConcurrency: z.number().min(1).max(20).optional(),
  rateLimitPerHost: z.number().min(1).max(20).optional(),
  allowFullDownload: z.boolean().optional(),
});

router.get("/sources", async (req, res, next) => {
  try {
    const schema = z.object({ chatbotId: z.string().min(8) });
    const payload = schema.parse(req.query);
    const sources = await knowledgeService.listSources(req.user!.id, payload.chatbotId);
    res.json(sources);
  } catch (error) {
    next(error);
  }
});

router.post("/sources/text", async (req, res, next) => {
  try {
    const payload = addTextSchema.parse(req.body);
    const source = await knowledgeService.addTextSource(req.user!.id, payload.chatbotId, payload.label, payload.content);
    res.status(201).json(source);
  } catch (error) {
    next(error);
  }
});

router.post("/sources/scrape", async (req, res, next) => {
  try {
    const payload = scrapeSchema.parse(req.body);
    const scrapeOptions = {
      startUrls: payload.startUrls,
      ...(payload.maxDepth !== undefined ? { maxDepth: payload.maxDepth } : {}),
      ...(payload.maxPages !== undefined ? { maxPages: payload.maxPages } : {}),
      ...(payload.respectRobotsTxt !== undefined ? { respectRobotsTxt: payload.respectRobotsTxt } : {}),
      ...(payload.includeGlobs?.length ? { includeGlobs: payload.includeGlobs } : {}),
      ...(payload.excludeGlobs?.length ? { excludeGlobs: payload.excludeGlobs } : {}),
      ...(payload.maxConcurrency !== undefined ? { maxConcurrency: payload.maxConcurrency } : {}),
      ...(payload.rateLimitPerHost !== undefined ? { rateLimitPerHost: payload.rateLimitPerHost } : {}),
      ...(payload.allowFullDownload !== undefined ? { allowFullDownload: payload.allowFullDownload } : {}),
    };
    // Create pending placeholder
    const pendingSource = await prisma.knowledgeSource.create({
      data: {
        chatbotId: payload.chatbotId,
        label: payload.startUrls[0] ?? "Scrape",
        type: "URL",
        status: "PENDING",
        uri: payload.startUrls[0] ?? null,
        metadata: {},
      },
    });

    // Fire-and-forget background job
    void knowledgeService
      .scrapeAndIngest(req.user!.id, payload.chatbotId, scrapeOptions)
      .then(async () => {
        await prisma.knowledgeSource.update({ where: { id: pendingSource.id }, data: { status: "READY" } });
      })
      .catch(async (err) => {
        await prisma.knowledgeSource.update({ where: { id: pendingSource.id }, data: { status: "FAILED" } });
        console.error("Background scrape failed", err);
      });

    res.status(202).json({ status: "PENDING", sourceId: pendingSource.id });
  } catch (error) {
    next(error);
  }
});

router.delete("/sources/:id", async (req, res, next) => {
  try {
    await knowledgeService.deleteSource(req.user!.id, req.params.id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
