import { randomUUID } from "node:crypto";
import type { VectorMatch, VectorMetadata, VectorStore } from "./types.js";

interface StoredVector {
  id: string;
  vector: number[];
  metadata: VectorMetadata;
  content: string;
}

export class MemoryVectorStore implements VectorStore {
  private readonly store = new Map<string, StoredVector>();

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
    const id = vectorId ?? randomUUID();
    this.store.set(id, { id, vector, metadata, content });
    return id;
  }

  async similaritySearch({ chatbotId, vector, topK }: { chatbotId: string; vector: number[]; topK: number }) {
    const matches: VectorMatch[] = [];

    for (const item of this.store.values()) {
      if (item.metadata.chatbotId !== chatbotId) continue;
      const score = this.cosineSimilarity(vector, item.vector);
      matches.push({ id: item.id, score, metadata: item.metadata, content: item.content });
    }

    return matches
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async deleteByKnowledgeSource({ knowledgeSourceId }: { chatbotId: string; knowledgeSourceId: string }) {
    for (const [id, vector] of this.store.entries()) {
      if (vector.metadata.knowledgeSourceId === knowledgeSourceId) {
        this.store.delete(id);
      }
    }
  }

  private cosineSimilarity(a: number[], b: number[]) {
    const minLength = Math.min(a.length, b.length);
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < minLength; i += 1) {
      const valA = a[i]!;
      const valB = b[i]!;
      dot += valA * valB;
      magA += valA * valA;
      magB += valB * valB;
    }
    return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
  }
}
