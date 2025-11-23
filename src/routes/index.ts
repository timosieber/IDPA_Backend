import type { Express } from "express";
import { Router } from "express";
import { requireDashboardAuth } from "../middleware/require-auth.js";
import chatRouter from "./chat.routes.js";
import knowledgeRouter from "./knowledge.routes.js";

export const registerRoutes = (app: Express) => {
  const api = Router();

  api.use("/chat", chatRouter);
  api.use("/knowledge", requireDashboardAuth, knowledgeRouter);

  app.use("/api", api);
};
