import crypto from "node:crypto";
import { Pinecone } from "@pinecone-database/pinecone";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import type { VectorMatch, VectorMetadata, VectorStore } from "./types.js";

export class PineconeVectorStore implements VectorStore {
  private readonly index;

  constructor() {
    if (!env.PINECONE_API_KEY || !env.PINECONE_INDEX) {
      throw new Error("Pinecone nicht vollständig konfiguriert");
    }
    const client = new Pinecone({ apiKey: env.PINECONE_API_KEY });
    this.index = client.Index(env.PINECONE_INDEX);
  }

  async upsertEmbedding({
    vectorId,
    vector,
    metadata,
    content,
  }: {
    vectorId?: string;
    vector: number[];
    metadata: VectorMetadata;
    content: string;
  }) {
    const id = vectorId ?? crypto.randomUUID();
    const ns = metadata.chatbotId ?? "global";
    await this.index.namespace(ns).upsert([
      {
        id,
        values: vector,
        metadata: {
          ...metadata,
          content,
        },
      },
    ]);
    return id;
  }

  async similaritySearch({ chatbotId, vector, topK }: { chatbotId: string; vector: number[]; topK: number }) {
    const ns = chatbotId || "global";
    const response = await this.index.namespace(ns).query({
      vector,
      topK,
      includeMetadata: true,
    });

    return (
      response.matches?.map((match) => ({
        id: match.id,
        score: match.score ?? 0,
        metadata: (match.metadata as Record<string, any>) ?? { chatbotId: ns },
        content: String(match.metadata?.content ?? ""),
      })) ?? []
    );
  }

  async deleteByKnowledgeSource({ chatbotId, knowledgeSourceId }: { chatbotId: string; knowledgeSourceId: string }) {
    try {
      const ns = chatbotId || "global";
      await this.index.namespace(ns).deleteMany({ knowledgeSourceId });
    } catch (error) {
      logger.error({ err: error }, "Pinecone delete failed");
    }
  }
}
