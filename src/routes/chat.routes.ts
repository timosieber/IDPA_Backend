import { Router } from "express";
import { z } from "zod";
import { sessionService } from "../services/session.service.js";
import { chatService } from "../services/chat.service.js";
import { extractBearerToken } from "../utils/token.js";
import { BadRequestError } from "../utils/errors.js";

const router = Router();

const sessionSchema = z.object({
  chatbotId: z.string().min(8),
});

const messageSchema = z.object({
  sessionId: z.string().min(8),
  message: z.string().min(1),
});

router.post("/sessions", async (req, res, next) => {
  try {
    const payload = sessionSchema.parse(req.body);
    const origin = (req.get("origin") ?? req.get("referer")) || undefined;
    const session = await sessionService.createSession({
      chatbotId: payload.chatbotId,
      origin,
      ip: req.ip,
    });
    res.status(201).json(session);
  } catch (error) {
    next(error);
  }
});

router.post("/messages", async (req, res, next) => {
  try {
    const payload = messageSchema.parse(req.body);
    const token = extractBearerToken(req.header("authorization"));
    const session = await sessionService.requireValidSession(token ?? "");
    if (session.id !== payload.sessionId) {
      throw new BadRequestError("SessionId stimmt nicht mit dem Token überein");
    }
    const result = await chatService.handleMessage(session, payload.message);
    res.json({
      sessionId: payload.sessionId,
      answer: result.answer,
      context: result.context,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
