import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import type { Express, Request, Response, NextFunction } from "express";
import { env } from "./config/env.js";
import { chatService } from "./services/chat.service.js";
import { knowledgeService } from "./services/knowledge.service.js";
import { provisioningEventsService } from "./services/provisioning-events.service.js";
import { apiRateLimiter } from "./middleware/rate-limit.js";
import { errorHandler } from "./middleware/error-handler.js";
import { requireDashboardAuth } from "./middleware/require-auth.js";
import { prisma } from "./lib/prisma.js";
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

      await knowledgeService.purgeChatbotVectors(chatbotId);
      await prisma.chatbot.delete({ where: { id: chatbotId } });
      res.status(204).send();
    } catch (err) {
      console.error("DELETE /api/chatbots/:id error:", err);
      res.status(500).json({ error: "Fehler beim Löschen" });
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

  app.post("/api/knowledge/sources/scrape", requireDashboardAuth, async (req, res, next) => {
    try {
      console.log("Scrape Request empfangen. Body:", req.body);
      const body = req.body || {};
      const rawUrl = body.url || body.link || (Array.isArray(body.startUrls) ? body.startUrls[0] : null);
      const url = typeof rawUrl === "string" ? rawUrl.trim() : null;
      const chatbotId = body.chatbotId;

      if (!chatbotId) {
        return res.status(400).json({ error: "chatbotId is required" });
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

      // Create a PENDING placeholder so the dashboard shows progress immediately
      const pendingSource = await prisma.knowledgeSource.create({
        data: {
          chatbotId,
          label: options.startUrls[0] ?? "Scrape",
          type: "URL",
          status: "PENDING",
          uri: options.startUrls[0] ?? null,
          metadata: { startedAt: new Date().toISOString() },
        },
      });

      // fire-and-forget mit User-ID
      void knowledgeService
        .scrapeAndIngest(req.user!.id, chatbotId, options)
        .then(async () => {
          await prisma.knowledgeSource.update({ where: { id: pendingSource.id }, data: { status: "READY" } }).catch(() => {});
          await prisma.chatbot.update({ where: { id: chatbotId }, data: { status: "ACTIVE" } });
          provisioningEventsService.publish(chatbotId, { type: "completed", chatbotId, status: "ACTIVE" });
        })
        .catch((err) => {
          console.error("ScrapeAndIngest Fehler:", err);
          void prisma.knowledgeSource.update({ where: { id: pendingSource.id }, data: { status: "FAILED" } }).catch(() => {});
          provisioningEventsService.publish(chatbotId, {
            type: "failed",
            chatbotId,
            status: "DRAFT",
            error: err instanceof Error ? err.message : String(err),
          });
        });

      res.status(202).json({ status: "PENDING" });
    } catch (err) {
      console.error("ScrapeAndIngest Fehler:", err);
      next(err);
    }
  });

  app.post("/api/knowledge/sources/text", requireDashboardAuth, async (req, res, next) => {
    try {
      const { chatbotId, title, content } = req.body || {};
      if (!chatbotId) return res.status(400).json({ error: "chatbotId ist erforderlich" });
      if (!title || !content) return res.status(400).json({ error: "title und content sind erforderlich" });

      // Prüfe ob der User Zugriff auf diesen Chatbot hat (mit Legacy-Migration)
      const { allowed } = await checkChatbotOwnership(chatbotId, req.user!.id);
      if (!allowed) {
        return res.status(403).json({ error: "Zugriff verweigert" });
      }

      await knowledgeService.addTextSource(req.user!.id, chatbotId, title, content);
      // Wenn der Bot bisher noch nicht aktiv ist, schalte ihn nach erfolgreichem Ingest frei
      await prisma.chatbot.update({ where: { id: chatbotId }, data: { status: "ACTIVE" } }).catch(() => {});
      provisioningEventsService.publish(chatbotId, { type: "completed", chatbotId, status: "ACTIVE" });
      res.status(201).json({ success: true });
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

      await knowledgeService.deleteSource(req.user!.id, sourceId);
      res.status(204).send();
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

      // Quellen werden separat geliefert; entferne "Quellen:"-Block aus der Answer-Message
      const answer = typeof result.answer === "string"
        ? result.answer
          .replace(/\n{1,2}Quellen:\s[\s\S]*$/u, "")
          .replace(/^Vielen Dank für Ihre Anfrage!?[\s\n]*/iu, "")
          .replace(/^Danke für Ihre Anfrage!?[\s\n]*/iu, "")
          .trim()
        : result.answer;

      res.json({
        sessionId: sessionId ?? null,
        answer,
        context: result.context,
        sources: result.sources,
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
