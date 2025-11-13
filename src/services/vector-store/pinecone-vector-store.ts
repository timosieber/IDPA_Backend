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
    await this.index.namespace(metadata.chatbotId).upsert([
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
    const response = await this.index.namespace(chatbotId).query({
      vector,
      topK,
      includeMetadata: true,
    });

    return (
      response.matches?.map((match) => ({
        id: match.id,
        score: match.score ?? 0,
        metadata: {
          chatbotId,
          knowledgeSourceId: String(match.metadata?.knowledgeSourceId ?? ""),
          chunkIndex: Number(match.metadata?.chunkIndex ?? 0),
          label: String(match.metadata?.label ?? ""),
        },
        content: String(match.metadata?.content ?? ""),
      })) ?? []
    );
  }

  async deleteByKnowledgeSource({ chatbotId, knowledgeSourceId }: { chatbotId: string; knowledgeSourceId: string }) {
    try {
      await this.index.namespace(chatbotId).deleteMany({ knowledgeSourceId });
    } catch (error) {
      logger.error({ err: error }, "Pinecone delete failed");
    }
  }
}
