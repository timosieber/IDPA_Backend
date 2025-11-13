import type { Express } from "express";
import { Router } from "express";
import { requireDashboardAuth } from "../middleware/require-auth.js";
import chatbotsRouter from "./chatbots.routes.js";
import chatRouter from "./chat.routes.js";
import knowledgeRouter from "./knowledge.routes.js";

export const registerRoutes = (app: Express) => {
  const api = Router();

  api.use("/chat", chatRouter);
  api.use("/chatbots", requireDashboardAuth, chatbotsRouter);
  api.use("/knowledge", requireDashboardAuth, knowledgeRouter);

  app.use("/api", api);
};
