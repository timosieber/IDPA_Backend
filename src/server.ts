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

    const isLocalhost = LOCALHOST_PORTS.some((port) => origin.startsWith(`http://localhost:${port}`) || origin.startsWith(`http://127.0.0.1:${port}`));
    const isAllowedEnv = env.CORS_ALLOWED_ORIGINS_LIST.length
      ? env.CORS_ALLOWED_ORIGINS_LIST.includes(origin)
      : false;

    if (isLocalhost || isAllowedEnv) return callback(null, true);
    return callback(new Error("Origin not allowed by CORS"));
  },
  credentials: true,
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

  const makeBot = (bot?: any) => ({
    id: bot?.id ?? "default-bot",
    userId: bot?.userId ?? "system",
    name: bot?.name ?? "RAG Assistant",
    description: bot?.description ?? "Default RAG Assistant",
    systemPrompt: bot?.systemPrompt ?? null,
    logoUrl: bot?.logoUrl ?? null,
    allowedDomains: bot?.allowedDomains ?? [],
    theme: bot?.theme ?? null,
    model: bot?.model ?? "gpt-4o",
    status: (bot?.status as any) ?? "ACTIVE",
    createdAt: bot?.createdAt ?? new Date().toISOString(),
    updatedAt: bot?.updatedAt ?? new Date().toISOString(),
  });
  const defaultBot = makeBot();
  const ensureSystemUser = async () => {
    const email = "system@local";
    const existing = await prisma.user.findFirst({ where: { email } });
    if (existing) return existing.id;
    const created = await prisma.user.create({ data: { email } });
    return created.id;
  };

  app.get("/api/chatbots", async (_req, res) => {
    try {
      const bots = await prisma.chatbot.findMany({ orderBy: { createdAt: "desc" } });
      if (!bots.length) return res.json([makeBot()]);
      return res.json(bots.map(makeBot));
    } catch (err) {
      console.error("GET /api/chatbots error:", err);
      return res.json([makeBot()]);
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
          model: req.body?.model || "gpt-4o",
          status: req.body?.status || "ACTIVE",
        },
      });
      res.status(201).json(makeBot(bot));
    } catch (err) {
      console.error("POST /api/chatbots error:", err);
      res.status(201).json(makeBot());
    }
  });

  app.get("/api/chatbots/:id", async (req, res) => {
    try {
      const bot = await prisma.chatbot.findUnique({ where: { id: req.params.id } });
      if (!bot) return res.json(makeBot({ id: req.params.id }));
      return res.json(makeBot(bot));
    } catch (err) {
      console.error("GET /api/chatbots/:id error:", err);
      return res.json(makeBot({ id: req.params.id }));
    }
  });

  app.patch("/api/chatbots/:id", (req, res) => {
    const name = req.body?.name || defaultBot.name;
    res.json(makeBot({ id: req.params.id || defaultBot.id, name }));
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
  app.get("/api/knowledge/sources", async (_req, res, next) => {
    try {
      const sources = await knowledgeService.listSources().catch(() => []);
      res.json(sources ?? []);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/knowledge/sources/scrape", async (req, res, next) => {
    try {
      console.log("Scrape Request empfangen. Body:", req.body);
      const body = req.body || {};
      const url = body.url || body.link || (Array.isArray(body.startUrls) ? body.startUrls[0] : null);
      const chatbotId = body.chatbotId || "default-bot";
      if (!url) {
        console.error("URL fehlt!");
        return res.status(400).json({ error: "URL is required" });
      }
      const options = {
        startUrls: Array.isArray(body.startUrls) && body.startUrls.length ? body.startUrls : [url],
        maxDepth: body.maxDepth,
        maxPages: body.maxPages,
        respectRobotsTxt: body.respectRobotsTxt,
        includeGlobs: body.includeGlobs,
        excludeGlobs: body.excludeGlobs,
        maxConcurrency: body.maxConcurrency,
        rateLimitPerHost: body.rateLimitPerHost,
        allowFullDownload: body.allowFullDownload,
      };
      await knowledgeService.scrapeAndIngest("system", chatbotId, options);
      res.json({ success: true });
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
    const chatbotId = req.body?.chatbotId || "default-bot";
    const sessionId = randomUUID();
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    res.status(201).json({ sessionId, token, expiresAt, chatbotId });
  });

  app.post("/api/chat/messages", async (req, res, next) => {
    try {
      const chatbotId = req.body?.chatbotId || "default-bot";
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
