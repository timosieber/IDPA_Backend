import type { Message } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

class MessageService {
  async logMessage(sessionId: string, role: "user" | "assistant" | "system", content: string): Promise<Message> {
    return prisma.message.create({
      data: {
        sessionId,
        role,
        content,
      },
    });
  }

  async getRecentMessages(sessionId: string, limit = 15): Promise<Message[]> {
    return prisma.message.findMany({
      where: { sessionId },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
  }
}

export const messageService = new MessageService();
