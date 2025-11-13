import crypto from "node:crypto";
import OpenAI from "openai";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

class EmbeddingService {
  private readonly client?: OpenAI;

  constructor() {
    if (env.OPENAI_API_KEY) {
      this.client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    }
  }

  async embedText(text: string) {
    if (!text.trim()) {
      throw new Error("Text darf nicht leer sein");
    }

    if (!this.client) {
      return this.mockEmbedding(text);
    }

    const response = await this.client.embeddings.create({
      model: env.OPENAI_EMBEDDINGS_MODEL,
      input: text,
    });

    return response.data[0]?.embedding ?? this.mockEmbedding(text);
  }

  private mockEmbedding(text: string) {
    const hash = crypto.createHash("sha256").update(text).digest();
    const vector = Array.from(hash).map((byte) => (byte / 255) * 2 - 1);
    logger.warn("OPENAI_API_KEY nicht gesetzt – Mock-Embeddings werden verwendet");
    return vector;
  }
}

export const embeddingService = new EmbeddingService();
