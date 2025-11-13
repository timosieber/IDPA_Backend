import { addMinutes, isBefore } from "date-fns";
import { nanoid } from "nanoid";
import type { Prisma } from "../lib/prisma-client.js";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { ensureDomainAllowed } from "../utils/domain.js";
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from "../utils/errors.js";
import { hashToken, signSessionToken, verifySessionToken } from "../utils/token.js";
import { logger } from "../lib/logger.js";

class SessionService {
  async createSession({
    chatbotId,
    origin,
    ip,
  }: {
    chatbotId: string;
    origin?: string | undefined;
    ip?: string | undefined;
  }) {
    const chatbot = await prisma.chatbot.findUnique({ where: { id: chatbotId } });
    if (!chatbot) {
      throw new NotFoundError("Chatbot existiert nicht");
    }
    if (chatbot.status !== "ACTIVE") {
      throw new ForbiddenError("Chatbot ist nicht aktiv");
    }

    ensureDomainAllowed(origin, chatbot.allowedDomains as string[]);

    const expiresAt = addMinutes(new Date(), env.SESSION_TTL_MINUTES);
    const sessionId = nanoid(21);
    const token = signSessionToken({ sessionId, chatbotId });
    const hashed = hashToken(token);

    const data: Prisma.SessionUncheckedCreateInput = {
      id: sessionId,
      chatbotId,
      origin: origin ?? "unknown",
      ip: ip ?? null,
      expiresAt,
      token: hashed,
    };

    await prisma.session.create({ data });

    return { sessionId, token, expiresAt };
  }

  async requireValidSession(token: string) {
    if (!token) {
      throw new UnauthorizedError("Session-Token fehlt");
    }

    const payload = verifySessionToken(token);
    const session = await prisma.session.findUnique({
      where: { id: payload.sessionId },
      include: { chatbot: true },
    });

    if (!session || session.chatbotId !== payload.chatbotId) {
      throw new UnauthorizedError("Session existiert nicht mehr");
    }

    if (session.token !== hashToken(token)) {
      throw new UnauthorizedError("Token wurde widerrufen");
    }

    if (isBefore(session.expiresAt, new Date())) {
      throw new UnauthorizedError("Session ist abgelaufen");
    }

    return session;
  }

  async revokeSessionsForChatbot(chatbotId: string) {
    await prisma.session.deleteMany({ where: { chatbotId } });
    logger.info({ chatbotId }, "Alle Sessions wurden widerrufen");
  }
}

export const sessionService = new SessionService();
