import type { Chatbot, Session, Message } from "../lib/prisma-client.js";
import { BadRequestError } from "../utils/errors.js";
import { knowledgeService } from "./knowledge.service.js";
import { llmService } from "./llm.service.js";
import { messageService } from "./message.service.js";

type SessionWithChatbot = Session & { chatbot: Chatbot };

class ChatService {
  async handleMessage(session: SessionWithChatbot, content: string) {
    if (!content?.trim()) {
      throw new BadRequestError("Message darf nicht leer sein");
    }

    const history = await messageService.getRecentMessages(session.id);
    await messageService.logMessage(session.id, "user", content);

    const context = await knowledgeService.retrieveContext(session.chatbotId, content);
    const response = await llmService.generateResponse({
      chatbot: {
        name: session.chatbot.name,
        description: session.chatbot.description,
        model: session.chatbot.model,
      },
      messages: history.map((message: Message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      })),
      context,
      question: content,
    });

    await messageService.logMessage(session.id, "assistant", response);

    return { answer: response, context };
  }
}

export const chatService = new ChatService();
