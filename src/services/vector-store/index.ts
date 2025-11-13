import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { MemoryVectorStore } from "./memory-vector-store.js";
import { PineconeVectorStore } from "./pinecone-vector-store.js";
import type { VectorStore } from "./types.js";

let instance: VectorStore;

export const getVectorStore = (): VectorStore => {
  if (instance) return instance;

  if (env.VECTOR_DB_PROVIDER === "pinecone") {
    try {
      instance = new PineconeVectorStore();
      logger.info("Pinecone Vector Store initialisiert");
      return instance;
    } catch (error) {
      logger.error({ err: error }, "Pinecone konnte nicht initialisiert werden – fallback memory");
    }
  }

  instance = new MemoryVectorStore();
  logger.warn("Verwende Memory Vector Store (nur für lokale Entwicklung geeignet)");
  return instance;
};
