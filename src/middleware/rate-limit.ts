import rateLimit from "express-rate-limit";
import { env } from "../config/env.js";

export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.RATE_LIMIT_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Zu viele Anfragen – bitte später erneut versuchen." },
});

export const widgetRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Chatbot: Zu viele Anfragen von dieser IP – bitte kurz warten." },
});
