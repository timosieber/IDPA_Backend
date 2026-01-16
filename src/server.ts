import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import type { Express, Request, Response, NextFunction } from "express";
import { env } from "./config/env.js";
import { chatService } from "./services/chat.service.js";
import { knowledgeService } from "./services/knowledge.service.js";
import { ingestionWorker } from "./services/ingestion/ingestion-worker.js";
import { provisioningEventsService } from "./services/provisioning-events.service.js";
import { apiRateLimiter } from "./middleware/rate-limit.js";
import { errorHandler } from "./middleware/error-handler.js";
import voiceRouter from "./routes/voice.routes.js";
import { requireDashboardAuth } from "./middleware/require-auth.js";
import { prisma } from "./lib/prisma.js";
import { logger } from "./lib/logger.js";
import { randomUUID } from "node:crypto";

const LOCALHOST_PORTS = ["3000", "4200", "5173", "8080"];
const DEFAULT_CHATBOT_ID = "default-bot";

const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Erlaube Requests ohne Origin (z.B. Server-to-Server, Postman)
    if (!origin) return callback(null, true);

    const isLocalhost = LOCALHOST_PORTS.some(
      (port) => origin.startsWith(`http://localhost:${port}`) || origin.startsWith(`http://127.0.0.1:${port}`),
    );
    const isAllowedEnv = env.CORS_ALLOWED_ORIGINS_LIST.length
      ? env.CORS_ALLOWED_ORIGINS_LIST.includes(origin)
      : false; // Default: nicht erlaubt, wenn keine Origins konfiguriert

    if (isLocalhost || isAllowedEnv) {
      return callback(null, true);
    }

    // Origin nicht erlaubt
    return callback(new Error(`Origin ${origin} nicht erlaubt durch CORS`), false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  optionsSuccessStatus: 200,
};

export const buildServer = (): Express => {
  const app = express();

  ingestionWorker.start();

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

  // Convenience alias when the frontend reverse-proxies /api/* to the backend.
  app.get("/api/healthz", (_req, res) =>
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
    }),
  );

  // Debug endpoint to check job status and sources
  app.get("/api/debug/job-status/:jobId", async (req, res) => {
    try {
      const job = await prisma.ingestionJob.findUnique({ where: { id: req.params.jobId } });
      if (!job) return res.status(404).json({ error: "Job not found" });
      const sourceCount = await prisma.knowledgeSource.count({ where: { chatbotId: job.chatbotId } });
      const pdfSources = await prisma.knowledgeSource.findMany({
        where: { chatbotId: job.chatbotId },
        select: { label: true, canonicalUrl: true, type: true, status: true },
        orderBy: { createdAt: "desc" },
        take: 20,
      });
      res.json({ job, sourceCount, recentSources: pdfSources });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Add text source
  app.post("/api/debug/add-text/:chatbotId", async (req, res) => {
    const secret = req.headers["x-admin-secret"];
    if (secret !== "temp-2024-rescrape") return res.status(401).json({ error: "Unauthorized" });
    try {
      const { title, content, canonicalUrl } = req.body;
      const { jobId, knowledgeSourceId } = await knowledgeService.startTextIngestion(
        "system-admin",
        req.params.chatbotId,
        title,
        content,
        { canonicalUrl }
      );
      res.json({ status: "PENDING", jobId, knowledgeSourceId });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.use("/api", apiRateLimiter);

  // Voice routes (with own rate limiting, no JSON body parsing needed)
  app.use("/api/voice", voiceRouter);

  const makeBot = (bot: any) => ({
    id: bot.id,
    userId: bot.userId,
    name: bot.name,
    description: bot.description ?? null,
    systemPrompt: bot.systemPrompt ?? null,
    logoUrl: bot.logoUrl ?? null,
    allowedDomains: bot.allowedDomains ?? [],
    theme: bot.theme ?? null,
    model: bot.model ?? "gpt-4o-mini",
    status: bot.status ?? "ACTIVE",
    createdAt: bot.createdAt ?? new Date().toISOString(),
    updatedAt: bot.updatedAt ?? new Date().toISOString(),
  });

  const getBot = async (chatbotId: string) => {
    const bot = await prisma.chatbot.findUnique({ where: { id: chatbotId } });
    return bot;
  };

  app.get("/api/chatbots", requireDashboardAuth, async (req, res) => {
    try {
      const bots = await prisma.chatbot.findMany({
        where: { userId: req.user!.id },
        orderBy: { createdAt: "desc" },
      });
      return res.json(bots.map(makeBot));
    } catch (err) {
      console.error("GET /api/chatbots error:", err);
      return res.json([]);
    }
  });

  app.post("/api/chatbots", requireDashboardAuth, async (req, res) => {
    try {
      const name = req.body?.name || "RAG Assistant";
      const bot = await prisma.chatbot.create({
        data: {
          userId: req.user!.id,
          name,
          description: req.body?.description ?? null,
          allowedDomains: Array.isArray(req.body?.allowedDomains) ? req.body.allowedDomains : [],
          model: req.body?.model || env.OPENAI_COMPLETIONS_MODEL || "gpt-4o-mini",
          status: req.body?.status || "DRAFT",
        },
      });
      res.status(201).json(makeBot(bot));
    } catch (err) {
      console.error("POST /api/chatbots error:", err);
      res.status(400).json({ error: "Chatbot konnte nicht erstellt werden" });
    }
  });

  app.get("/api/chatbots/:id", requireDashboardAuth, async (req, res) => {
    try {
      const chatbotId = req.params.id;
      if (!chatbotId) return res.status(400).json({ error: "chatbotId required" });

      const { allowed, bot } = await checkChatbotOwnership(chatbotId, req.user!.id);
      if (!bot) return res.status(404).json({ error: "Chatbot nicht gefunden" });
      if (!allowed) return res.status(403).json({ error: "Zugriff verweigert" });
      return res.json(makeBot(bot));
    } catch (err) {
      console.error("GET /api/chatbots/:id error:", err);
      return res.status(404).json({ error: "Chatbot nicht gefunden" });
    }
  });

  app.patch("/api/chatbots/:id", requireDashboardAuth, async (req, res) => {
    try {
      const chatbotId = req.params.id;
      if (!chatbotId) return res.status(400).json({ error: "chatbotId required" });

      const { allowed, bot: existing } = await checkChatbotOwnership(chatbotId, req.user!.id);
      if (!existing) return res.status(404).json({ error: "Chatbot nicht gefunden" });
      if (!allowed) return res.status(403).json({ error: "Zugriff verweigert" });

      const updateData: Record<string, unknown> = {};
      if (req.body?.name !== undefined) updateData.name = req.body.name;
      if (req.body?.description !== undefined) updateData.description = req.body.description;
      if (req.body?.systemPrompt !== undefined) updateData.systemPrompt = req.body.systemPrompt;
      if (req.body?.logoUrl !== undefined) updateData.logoUrl = req.body.logoUrl;
      if (req.body?.theme !== undefined) updateData.theme = req.body.theme;
      if (req.body?.model !== undefined) updateData.model = req.body.model;
      if (req.body?.status !== undefined) updateData.status = req.body.status;
      if (req.body?.allowedDomains !== undefined) updateData.allowedDomains = req.body.allowedDomains;

      // If the user updates the system prompt manually, disable auto-system-prompt updates.
      if (req.body?.systemPrompt !== undefined) {
        const existingTheme = existing.theme && typeof existing.theme === "object" ? existing.theme as Record<string, unknown> : {};
        const requestedTheme = req.body?.theme && typeof req.body.theme === "object" ? req.body.theme as Record<string, unknown> : null;
        updateData.theme = {
          ...(requestedTheme ?? existingTheme),
          autoSystemPrompt: false,
        };
      }

      const updated = await prisma.chatbot.update({
        where: { id: chatbotId },
        data: updateData,
      });

      res.json(makeBot(updated));
    } catch (err) {
      console.error("PATCH /api/chatbots/:id error:", err);
      res.status(400).json({ error: "Chatbot konnte nicht aktualisiert werden" });
    }
  });

  app.delete("/api/chatbots/:id", requireDashboardAuth, async (req, res) => {
    const chatbotId = req.params.id;
    if (!chatbotId) return res.status(400).json({ error: "chatbotId required" });

    try {
      const { allowed, bot: existing } = await checkChatbotOwnership(chatbotId, req.user!.id);
      if (!existing) return res.status(404).json({ error: "Chatbot nicht gefunden" });
      if (!allowed) return res.status(403).json({ error: "Zugriff verweigert" });

      // Delete chatbot from DB first (cascades to related records)
      await prisma.chatbot.delete({ where: { id: chatbotId } });

      // Respond immediately - don't block on vector deletion
      res.status(204).send();

      // Purge vectors asynchronously in the background (fire-and-forget)
      // This prevents Gateway Timeout (502) on Railway for large vector sets
      knowledgeService.purgeChatbotVectors(chatbotId).catch((purgeError) => {
        logger.warn({
          chatbotId,
          userId: req.user!.id,
          error: purgeError instanceof Error ? purgeError.message : String(purgeError),
        }, "DELETE /api/chatbots/:id warning: purgeChatbotVectors failed (async cleanup)");
      });
    } catch (err) {
      console.error("DELETE /api/chatbots/:id error:", err);
      res.status(500).json({ error: "Fehler beim Löschen" });
    }
  });

  app.post("/api/chat", async (req: Request, res: Response, next: NextFunction) => {
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

      if (env.NODE_ENV !== "production") {
        logger.info(
          {
            chatbotId,
            historyLen: history.length,
            bodyKeys: req.body && typeof req.body === "object" ? Object.keys(req.body) : [],
          },
          "Incoming /api/chat request",
        );
      }

      const result = await chatService.generateResponse({ chatbotId, message, history });

      return res.json(result);
    } catch (error) {
      return next(error);
    }
  });

  // Helper: Prüft Chatbot-Ownership und migriert legacy Chatbots
  const checkChatbotOwnership = async (chatbotId: string, userId: string): Promise<{ allowed: boolean; bot: any }> => {
    const bot = await prisma.chatbot.findUnique({ where: { id: chatbotId } });
    if (!bot) return { allowed: false, bot: null };

    // Legacy-Migration: Wenn der Chatbot einem "system" User gehört, übernimm ihn
    if (bot.userId !== userId) {
      const ownerExists = await prisma.user.findUnique({ where: { id: bot.userId } });
      if (!ownerExists || bot.userId.startsWith("system") || bot.userId === "system") {
        // Migriere den Chatbot zum aktuellen User
        await prisma.chatbot.update({ where: { id: chatbotId }, data: { userId } });
        return { allowed: true, bot: { ...bot, userId } };
      }
      return { allowed: false, bot };
    }

    return { allowed: true, bot };
  };

  // Knowledge routes (protected)
  app.get("/api/knowledge/provisioning/stream", requireDashboardAuth, async (req, res) => {
    const chatbotId = (req.query?.chatbotId as string) || "";
    if (!chatbotId) return res.status(400).json({ error: "chatbotId is required" });

    const { allowed } = await checkChatbotOwnership(chatbotId, req.user!.id);
    if (!allowed) return res.status(403).json({ error: "Zugriff verweigert" });

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    // Initial snapshot (so UI can render immediately)
    const [bot, pendingCount, failedCount] = await Promise.all([
      prisma.chatbot.findUnique({ where: { id: chatbotId } }).catch(() => null),
      prisma.knowledgeSource.count({ where: { chatbotId, status: "PENDING" } }).catch(() => 0),
      prisma.knowledgeSource.count({ where: { chatbotId, status: "FAILED" } }).catch(() => 0),
    ]);

    res.write(`event: provisioning\n`);
    res.write(
      `data: ${JSON.stringify({
        type: "snapshot",
        chatbotId,
        chatbotStatus: bot?.status ?? null,
        pendingSources: pendingCount,
        failedSources: failedCount,
        updatedAt: bot?.updatedAt ?? null,
      })}\n\n`,
    );

    provisioningEventsService.subscribe(chatbotId, res);

    const keepAlive = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {
        // ignore
      }
    }, 15000);

    req.on("close", () => {
      clearInterval(keepAlive);
      provisioningEventsService.unsubscribe(chatbotId, res);
    });
  });

  app.get("/api/knowledge/sources", requireDashboardAuth, async (req, res, next) => {
    try {
      const chatbotId = (req.query?.chatbotId as string) || undefined;
      if (chatbotId) {
        const { allowed } = await checkChatbotOwnership(chatbotId, req.user!.id);
        if (!allowed) {
          return res.status(403).json({ error: "Zugriff verweigert" });
        }
      }
      const sources = await knowledgeService.listSources(req.user!.id, chatbotId).catch(() => []);
      res.json(sources ?? []);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/knowledge/jobs/:id", requireDashboardAuth, async (req, res, next) => {
    try {
      const jobId = req.params.id;
      if (!jobId) return res.status(400).json({ error: "jobId is required" });

      const job = await prisma.ingestionJob.findUnique({ where: { id: jobId } });
      if (!job) return res.status(404).json({ error: "Job nicht gefunden" });

      const { allowed } = await checkChatbotOwnership(job.chatbotId, req.user!.id);
      if (!allowed) return res.status(403).json({ error: "Zugriff verweigert" });

      return res.json(job);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/knowledge/sources/scrape", requireDashboardAuth, async (req, res, next) => {
    try {
      const body = req.body || {};
      const rawUrl = body.url || body.link || (Array.isArray(body.startUrls) ? body.startUrls[0] : null);
      const url = typeof rawUrl === "string" ? rawUrl.trim() : null;
      const chatbotId = body.chatbotId;

      if (!chatbotId) {
        return res.status(400).json({ error: "chatbotId is required" });
      }

      if (env.NODE_ENV !== "production") {
        logger.info(
          {
            chatbotId,
            url,
            startUrlsCount: Array.isArray(body.startUrls) ? body.startUrls.length : 0,
          },
          "Incoming /api/knowledge/sources/scrape request",
        );
      }

      // Prüfe ob der User Zugriff auf diesen Chatbot hat (mit Legacy-Migration)
      const { allowed } = await checkChatbotOwnership(chatbotId, req.user!.id);
      if (!allowed) {
        return res.status(403).json({ error: "Zugriff verweigert" });
      }

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

      provisioningEventsService.publish(chatbotId, { type: "started", chatbotId });
      const { jobId } = await knowledgeService.startScrapeIngestion(chatbotId, options);
      res.status(202).json({ status: "PENDING", jobId });
    } catch (err) {
      console.error("ScrapeAndIngest Fehler:", err);
      next(err);
    }
  });

  app.post("/api/knowledge/sources/text", requireDashboardAuth, async (req, res, next) => {
    try {
      const { chatbotId, title, content, sourceKey, canonicalUrl, originalUrl, extractionMethod, textQuality } = req.body || {};
      if (!chatbotId) return res.status(400).json({ error: "chatbotId ist erforderlich" });
      if (!title || !content) return res.status(400).json({ error: "title und content sind erforderlich" });

      // Prüfe ob der User Zugriff auf diesen Chatbot hat (mit Legacy-Migration)
      const { allowed } = await checkChatbotOwnership(chatbotId, req.user!.id);
      if (!allowed) {
        return res.status(403).json({ error: "Zugriff verweigert" });
      }

      const opts = {
        ...(typeof sourceKey === "string" ? { sourceKey } : {}),
        ...(typeof canonicalUrl === "string" ? { canonicalUrl } : {}),
        ...(typeof originalUrl === "string" ? { originalUrl } : {}),
        ...(typeof extractionMethod === "string" ? { extractionMethod } : {}),
        ...(typeof textQuality === "string" ? { textQuality } : {}),
      };
      const { jobId, knowledgeSourceId } = await knowledgeService.startTextIngestion(req.user!.id, chatbotId, title, content, opts);
      res.status(202).json({ status: "PENDING", jobId, knowledgeSourceId });
    } catch (err) {
      next(err);
    }
  });

  app.delete("/api/knowledge/sources/:id", requireDashboardAuth, async (req, res, next) => {
    try {
      const sourceId = req.params.id;
      if (!sourceId) return res.status(400).json({ error: "source id required" });

      // Prüfe ob der User Zugriff auf diese Source hat (mit Legacy-Migration)
      const source = await prisma.knowledgeSource.findUnique({
        where: { id: sourceId },
        include: { chatbot: true },
      });
      if (!source) {
        return res.status(404).json({ error: "Source nicht gefunden" });
      }

      const { allowed } = await checkChatbotOwnership(source.chatbotId, req.user!.id);
      if (!allowed) {
        return res.status(403).json({ error: "Zugriff verweigert" });
      }

      const { jobId } = await knowledgeService.startDeleteSource(source.chatbotId, sourceId);
      res.status(202).json({ status: "PENDING", jobId });
    } catch (err) {
      next(err);
    }
  });

  // Minimal chat session/messages endpoints for widget compatibility
  app.post("/api/chat/sessions", async (req, res) => {
    try {
      const chatbotId = req.body?.chatbotId || (req.query?.chatbotId as string);
      if (!chatbotId) return res.status(400).json({ error: "chatbotId required" });

      const bot = await getBot(chatbotId);
      if (!bot) return res.status(404).json({ error: "Chatbot nicht gefunden" });
      if (bot.status !== "ACTIVE") return res.status(503).json({ error: "Chatbot wird vorbereitet" });

      const token = randomUUID();
      const expiresAt = new Date(Date.now() + env.SESSION_TTL_MINUTES * 60 * 1000);
      const origin = req.headers.origin || req.headers.referer || "unknown";
      const ip = req.ip || req.socket.remoteAddress || null;

      // Session in DB speichern
      const session = await prisma.session.create({
        data: {
          chatbotId,
          origin,
          ip,
          token,
          expiresAt,
        },
      });

      res.status(201).json({
        sessionId: session.id,
        token: session.token,
        expiresAt: session.expiresAt.toISOString(),
        chatbotId,
        chatbot: {
          id: bot.id,
          name: bot.name,
          theme: bot.theme ?? null,
        },
      });
    } catch (err) {
      console.error("POST /api/chat/sessions error:", err);
      res.status(500).json({ error: "Fehler beim Erstellen der Session" });
    }
  });

  app.post("/api/chat/messages", async (req, res, next) => {
    try {
      const sessionId = req.body?.sessionId;
      const sessionToken = req.body?.token || req.headers.authorization?.replace("Bearer ", "");

      // Session validieren (optional - für Backward-Kompatibilität)
      let session = null;
      if (sessionId) {
        session = await prisma.session.findUnique({
          where: { id: sessionId },
          include: { chatbot: true },
        });

        // Session gefunden - validiere nur wenn Token mitgeschickt wurde
        if (session && sessionToken) {
          if (session.token !== sessionToken) {
            return res.status(401).json({ error: "Ungültiges Session-Token" });
          }
          if (new Date() > session.expiresAt) {
            return res.status(401).json({ error: "Session abgelaufen" });
          }
        }
        // Wenn Session nicht gefunden, ignorieren wir es und verwenden chatbotId aus Request
      }

      // chatbotId aus Session oder Request
      let chatbotId = session?.chatbotId || req.body?.chatbotId || (req.query?.chatbotId as string);
      if (!chatbotId) return res.status(400).json({ error: "chatbotId required" });

      const bot = session?.chatbot || await getBot(chatbotId);
      if (!bot) return res.status(404).json({ error: "Chatbot nicht gefunden" });
      if (bot.status !== "ACTIVE") return res.status(503).json({ error: "Chatbot wird vorbereitet" });

      const message = req.body?.message || req.body?.question || req.body?.prompt;
      if (!message) return res.status(400).json({ error: "message is required" });

      const result = await chatService.generateResponse({
        chatbotId,
        message,
        history: Array.isArray(req.body?.history) ? req.body.history : [],
      });

      res.json({
        sessionId: sessionId ?? null,
        rag: result,
      });
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
