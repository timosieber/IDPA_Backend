import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../utils/errors.js";
import { normalizeHostname } from "../utils/domain.js";

const themeSchema = z
  .object({
    primaryColor: z.string().optional(),
    backgroundColor: z.string().optional(),
    radius: z.number().optional(),
  })
  .partial()
  .optional();

export interface ChatbotPayload {
  name: string;
  description?: string | undefined;
  allowedDomains: string[];
  theme?: z.infer<typeof themeSchema> | undefined;
  model?: string | undefined;
  status?: "ACTIVE" | "DRAFT" | "PAUSED" | "ARCHIVED" | undefined;
}

class ChatbotService {
  private sanitizeDomains(domains: string[]) {
    const unique = Array.from(new Set(domains.map(normalizeHostname)));
    if (!unique.length) {
      throw new BadRequestError("Mindestens eine Domain ist erforderlich");
    }
    return unique;
  }

  async create(userId: string, payload: ChatbotPayload) {
    const allowedDomains = this.sanitizeDomains(payload.allowedDomains);
    const theme = payload.theme ? themeSchema.parse(payload.theme) : undefined;

    const data: Prisma.ChatbotUncheckedCreateInput = {
      userId,
      name: payload.name,
      description: payload.description ?? null,
      allowedDomains,
      model: payload.model ?? "gpt-4o-mini",
      status: payload.status ?? "DRAFT",
    };

    if (theme) {
      data.theme = theme;
    }

    return prisma.chatbot.create({ data });
  }

  async list(userId: string) {
    return prisma.chatbot.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }

  async getById(userId: string, chatbotId: string) {
    const bot = await prisma.chatbot.findUnique({ where: { id: chatbotId } });
    if (!bot) {
      throw new NotFoundError("Chatbot nicht gefunden");
    }
    if (bot.userId !== userId) {
      throw new ForbiddenError("Kein Zugriff auf diesen Chatbot");
    }
    return bot;
  }

  async update(userId: string, chatbotId: string, payload: Partial<ChatbotPayload>) {
    await this.getById(userId, chatbotId);
    const allowedDomains = payload.allowedDomains ? this.sanitizeDomains(payload.allowedDomains) : undefined;
    const theme = payload.theme ? themeSchema.parse(payload.theme) : undefined;

    const data: Prisma.ChatbotUncheckedUpdateInput = {};

    if (payload.name !== undefined) data.name = payload.name;
    if (payload.description !== undefined) data.description = payload.description ?? null;
    if (allowedDomains) data.allowedDomains = allowedDomains;
    if (payload.model !== undefined) data.model = payload.model;
    if (payload.status !== undefined) data.status = payload.status;
    if (payload.theme !== undefined && theme) {
      data.theme = theme;
    }

    return prisma.chatbot.update({
      where: { id: chatbotId },
      data,
    });
  }

  async delete(userId: string, chatbotId: string) {
    await this.getById(userId, chatbotId);
    await prisma.chatbot.delete({ where: { id: chatbotId } });
  }

  async getPublic(chatbotId: string) {
    const bot = await prisma.chatbot.findUnique({ where: { id: chatbotId } });
    if (!bot || bot.status === "ARCHIVED") {
      throw new NotFoundError("Chatbot nicht gefunden");
    }
    return bot;
  }
}

export const chatbotService = new ChatbotService();
