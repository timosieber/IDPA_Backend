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

  const makeBot = (id = "default-bot", name = "RAG Assistant") => ({
    id,
    userId: "system",
    name,
    description: "Default RAG Assistant",
    systemPrompt: null,
    logoUrl: null,
    allowedDomains: [],
    theme: null,
    model: "gpt-4o",
    status: "ACTIVE" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const defaultBot = makeBot();

  app.get("/api/chatbots", (_req, res) => {
    res.json([makeBot()]);
  });

  app.post("/api/chatbots", (_req, res) => {
    res.status(201).json(makeBot());
  });

  app.get("/api/chatbots/:id", (_req, res) => {
    res.json(makeBot());
  });

  app.patch("/api/chatbots/:id", (req, res) => {
    const name = req.body?.name || defaultBot.name;
    res.json(makeBot(req.params.id || defaultBot.id, name));
  });

  app.delete("/api/chatbots/:id", (_req, res) => {
    res.status(204).send();
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
      const url = req.body?.url;
      if (!url) {
        console.error("URL fehlt!");
        return res.status(400).json({ error: "URL is required" });
      }
      await knowledgeService.scrapeAndIngest("system", "default-bot", { startUrls: [url] });
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
