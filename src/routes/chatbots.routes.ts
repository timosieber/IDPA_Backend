import { Router } from "express";
import { z } from "zod";
import { chatbotService, type ChatbotPayload } from "../services/chatbot.service.js";

const router = Router();

const chatbotSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
  allowedDomains: z.array(z.string().min(2)),
  theme: z
    .object({
      primaryColor: z.string().optional(),
      backgroundColor: z.string().optional(),
      radius: z.number().min(0).max(32).optional(),
    })
    .optional(),
  model: z.string().optional(),
  status: z.enum(["ACTIVE", "DRAFT", "PAUSED", "ARCHIVED"]).optional(),
});

router.post("/", async (req, res, next) => {
  try {
    const payload = chatbotSchema.parse(req.body) as ChatbotPayload;
    const chatbot = await chatbotService.create(req.user!.id, payload);
    res.status(201).json(chatbot);
  } catch (error) {
    next(error);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const chatbots = await chatbotService.list(req.user!.id);
    res.json(chatbots);
  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const chatbot = await chatbotService.getById(req.user!.id, req.params.id);
    res.json(chatbot);
  } catch (error) {
    next(error);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const payload = chatbotSchema.partial().parse(req.body) as Partial<ChatbotPayload>;
    const chatbot = await chatbotService.update(req.user!.id, req.params.id, payload);
    res.json(chatbot);
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    await chatbotService.delete(req.user!.id, req.params.id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
