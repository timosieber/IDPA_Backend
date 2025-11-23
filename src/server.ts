import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import type { Express, Request, Response, NextFunction } from "express";
import { env } from "./config/env.js";
import { chatService } from "./services/chat.service.js";
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
