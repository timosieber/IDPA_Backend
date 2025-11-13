import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import type { Express } from "express";
import { env } from "./config/env.js";
import { apiRateLimiter } from "./middleware/rate-limit.js";
import { registerRoutes } from "./routes/index.js";
import { errorHandler } from "./middleware/error-handler.js";

export const buildServer = (): Express => {
  const app = express();

  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || !env.CORS_ALLOWED_ORIGINS_LIST.length) {
          return callback(null, true);
        }

        if (env.CORS_ALLOWED_ORIGINS_LIST.includes(origin)) {
          return callback(null, true);
        }

        return callback(new Error("Origin not allowed by CORS"));
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));

  app.get("/healthz", (_req, res) =>
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
    }),
  );

  app.use("/api", apiRateLimiter);
  registerRoutes(app);

  app.use(errorHandler);
  return app;
};
