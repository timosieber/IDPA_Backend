import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import type { Express, Request, Response, NextFunction } from "express";
import { env } from "./config/env.js";
import { chatService } from "./services/chat.service.js";
import { knowledgeService } from "./services/knowledge.service.js";
import { apiRateLimiter } from "./middleware/rate-limit.js";
import { errorHandler } from "./middleware/error-handler.js";
import { prisma } from "./lib/prisma.js";
import { randomUUID } from "node:crypto";

const LOCALHOST_PORTS = ["3000", "4200", "5173", "8080"];
const DEFAULT_CHATBOT_ID = "default-bot";

const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) return callback(null, true);
    const isLocalhost = LOCALHOST_PORTS.some(
      (port) => origin.startsWith(`http://localhost:${port}`) || origin.startsWith(`http://127.0.0.1:${port}`),
    );
    const isAllowedEnv = env.CORS_ALLOWED_ORIGINS_LIST.length
      ? env.CORS_ALLOWED_ORIGINS_LIST.includes(origin)
      : true;
    if (isLocalhost || isAllowedEnv) return callback(null, true);
    return callback(null, true);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  optionsSuccessStatus: 200,
};

export const buildServer = (): Express => {
  const app = express();

  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors(corsOptions));
  app.use(express.json({ limit: "1mb" }));
  app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));

  app.get("/healthz", (_req, res) =>
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
    }),
  );

  app.use("/api", apiRateLimiter);

  const makeBot = (bot: any) => ({
    id: bot.id,
    userId: bot.userId,
    name: bot.name,
    description: bot.description ?? null,
    systemPrompt: bot.systemPrompt ?? null,
    logoUrl: bot.logoUrl ?? null,
    allowedDomains: bot.allowedDomains ?? [],
    theme: bot.theme ?? null,
    model: bot.model ?? "gpt-4o",
    status: bot.status ?? "ACTIVE",
    createdAt: bot.createdAt ?? new Date().toISOString(),
    updatedAt: bot.updatedAt ?? new Date().toISOString(),
  });
  const ensureSystemUser = async () => {
    const email = "system@local";
    const existing = await prisma.user.findFirst({ where: { email } });
    if (existing) return existing.id;
    const created = await prisma.user.create({ data: { email } });
    return created.id;
  };

  const getBot = async (chatbotId: string) => {
    const bot = await prisma.chatbot.findUnique({ where: { id: chatbotId } });
    return bot;
  };

  app.get("/api/chatbots", async (_req, res) => {
    try {
      const bots = await prisma.chatbot.findMany({ orderBy: { createdAt: "desc" } });
      return res.json(bots.map(makeBot));
    } catch (err) {
      console.error("GET /api/chatbots error:", err);
      return res.json([]);
    }
  });

  app.post("/api/chatbots", async (req, res) => {
    try {
      const name = req.body?.name || "RAG Assistant";
      const userId = req.body?.userId || (await ensureSystemUser());
      const bot = await prisma.chatbot.create({
        data: {
          userId,
          name,
          description: req.body?.description ?? null,
          allowedDomains: Array.isArray(req.body?.allowedDomains) ? req.body.allowedDomains : [],
          model: req.body?.model || env.OPENAI_COMPLETIONS_MODEL || "gpt-5.1",
          status: req.body?.status || "DRAFT",
        },
      });
      res.status(201).json(makeBot(bot));
    } catch (err) {
      console.error("POST /api/chatbots error:", err);
      res.status(400).json({ error: "Chatbot konnte nicht erstellt werden" });
    }
  });

  app.get("/api/chatbots/:id", async (req, res) => {
    try {
      const bot = await prisma.chatbot.findUnique({ where: { id: req.params.id } });
      if (!bot) return res.status(404).json({ error: "Chatbot nicht gefunden" });
      return res.json(makeBot(bot));
    } catch (err) {
      console.error("GET /api/chatbots/:id error:", err);
      return res.status(404).json({ error: "Chatbot nicht gefunden" });
    }
  });

  app.patch("/api/chatbots/:id", (req, res) => {
    res.status(501).json({ error: "Not implemented" });
  });

  app.delete("/api/chatbots/:id", async (req, res) => {
    const chatbotId = req.params.id;
    try {
      await knowledgeService.purgeChatbotVectors(chatbotId);
      await prisma.chatbot.delete({ where: { id: chatbotId } });
      res.status(204).send();
    } catch (err) {
      console.error("DELETE /api/chatbots/:id error:", err);
      // still return 204 to keep frontend flowing
      res.status(204).send();
    }
  });

  app.post("/api/chat", async (req: Request, res: Response, next: NextFunction) => {
    console.log("Received body:", req.body);
    try {
      const message = (req.body?.message || req.body?.question || req.body?.prompt || "").toString();
      if (!message.trim()) {
        return res.status(400).json({ error: "message/question/prompt ist erforderlich" });
      }

      const chatbotId = (req.body?.chatbotId || DEFAULT_CHATBOT_ID).toString();
      const history = Array.isArray(req.body?.history)
        ? req.body.history.map((h: any) => ({
            role: h?.role === "assistant" ? "assistant" : "user",
            content: h?.content ?? "",
          }))
        : [];

      const result = await chatService.generateResponse({ chatbotId, message, history });

      return res.json({
        answer: result.answer,
        sources: result.sources ?? [],
      });
    } catch (error) {
      return next(error);
    }
  });

  // Knowledge routes (legacy friendly)
  app.get("/api/knowledge/sources", async (req, res, next) => {
    try {
      const chatbotId = (req.query?.chatbotId as string) || undefined;
      const sources = await knowledgeService.listSources(undefined, chatbotId).catch(() => []);
      res.json(sources ?? []);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/knowledge/sources/scrape", async (req, res, next) => {
    try {
      console.log("Scrape Request empfangen. Body:", req.body);
      const body = req.body || {};
      const rawUrl = body.url || body.link || (Array.isArray(body.startUrls) ? body.startUrls[0] : null);
      const url = typeof rawUrl === "string" ? rawUrl.trim() : null;
      const chatbotId = body.chatbotId || "default-bot";
      if (!url) {
        console.error("URL fehlt!");
        return res.status(400).json({ error: "URL is required" });
      }
      const options = {
        startUrls: Array.isArray(body.startUrls) && body.startUrls.length
          ? body.startUrls.filter((u: string) => typeof u === "string" && u.trim().length > 0)
          : [url],
        maxDepth: body.maxDepth,
        maxPages: body.maxPages,
        respectRobotsTxt: body.respectRobotsTxt,
        includeGlobs: body.includeGlobs,
        excludeGlobs: body.excludeGlobs,
        maxConcurrency: body.maxConcurrency,
        rateLimitPerHost: body.rateLimitPerHost,
        allowFullDownload: body.allowFullDownload,
      };
      // fire-and-forget
      void knowledgeService
        .scrapeAndIngest("system", chatbotId, options)
        .then(async () => {
          await prisma.chatbot.update({ where: { id: chatbotId }, data: { status: "ACTIVE" } });
        })
        .catch((err) => console.error("ScrapeAndIngest Fehler:", err));
      res.status(202).json({ status: "PENDING" });
    } catch (err) {
      console.error("ScrapeAndIngest Fehler:", err);
      next(err);
    }
  });

  app.post("/api/knowledge/sources/text", async (req, res, next) => {
    try {
      const { title, content } = req.body || {};
      if (!title || !content) return res.status(400).json({ error: "title und content sind erforderlich" });
      await knowledgeService.addTextSource(title, content);
      res.status(201).json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  app.delete("/api/knowledge/sources/:id", async (req, res, next) => {
    try {
      await knowledgeService.deleteSource(req.params.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // Minimal chat session/messages endpoints for widget compatibility
  app.post("/api/chat/sessions", async (req, res) => {
    const chatbotId = req.body?.chatbotId || (req.query?.chatbotId as string);
    if (!chatbotId) return res.status(400).json({ error: "chatbotId required" });
    const bot = await getBot(chatbotId);
    if (!bot) return res.status(404).json({ error: "Chatbot nicht gefunden" });
    if (bot.status !== "ACTIVE") return res.status(503).json({ error: "Chatbot wird vorbereitet" });
    const sessionId = randomUUID();
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    res.status(201).json({ sessionId, token, expiresAt, chatbotId });
  });

  app.post("/api/chat/messages", async (req, res, next) => {
    try {
      const chatbotId = req.body?.chatbotId || (req.query?.chatbotId as string);
      if (!chatbotId) return res.status(400).json({ error: "chatbotId required" });
      const bot = await getBot(chatbotId);
      if (!bot) return res.status(404).json({ error: "Chatbot nicht gefunden" });
      if (bot.status !== "ACTIVE") return res.status(503).json({ error: "Chatbot wird vorbereitet" });
      const message = req.body?.message || req.body?.question || req.body?.prompt;
      if (!message) return res.status(400).json({ error: "message is required" });

      const result = await chatService.generateResponse({
        chatbotId,
        message,
        history: Array.isArray(req.body?.history) ? req.body.history : [],
      });
      res.json({ sessionId: req.body?.sessionId ?? null, answer: result.answer, context: result.context, sources: result.sources });
    } catch (err) {
      next(err);
    }
  });

  app.use(errorHandler);
  return app;
};

// Optional direct start (for standalone runs)
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const app = buildServer();
  const port = env.PORT || 4000;
  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}
